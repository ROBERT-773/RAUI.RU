'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '../lib/client';
import ProfileImageEditor from './profile-image-editor';

type Profile = {
  id: string;
  name: string;
  regionCodes: string[];
  published: boolean;
  imageId?: string | null;
};

export default function AgentPublicProfile({
  agencyId,
}: {
  agencyId?: string;
}) {
  const path = agencyId
    ? 'v1/search/professional-profile/agency/' + encodeURIComponent(agencyId)
    : 'v1/search/professional-profile';
  return <ProfileEditor key={path} path={path} agency={Boolean(agencyId)} />;
}

function ProfileEditor({ path, agency }: { path: string; agency: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [regions, setRegions] = useState<{ code: string; name: string }[]>([]);
  const [status, setStatus] = useState('Загружаем профиль…');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  function denyAccess() {
    setProfile(null);
    setReady(false);
    setSaving(false);
    setStatus(
      'Доступ к изменению этого профиля закрыт. Проверьте аккаунт и права в кабинете.',
    );
  }
  useEffect(() => {
    let active = true;
    mounted.current = true;
    Promise.all([
      api<{ profile: Profile | null }>(path),
      api<{ items: { code: string; name: string }[] }>('v1/regions'),
    ])
      .then(([data, catalogue]) => {
        if (!active) return;
        setProfile(data.profile);
        setRegions(catalogue.items);
        setReady(true);
        setStatus('');
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && [401, 403].includes(error.status))
          denyAccess();
        else setStatus('Не удалось загрузить настройки профиля.');
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [path]);
  return (
    <details>
      <summary>
        {agency ? 'Публичный профиль агентства' : 'Публичный профиль агента'}
      </summary>
      {ready && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving) return;
            const data = new FormData(event.currentTarget);
            setSaving(true);
            setStatus('');
            try {
              const saved = await api<Profile>(path, 'PATCH', {
                name: String(data.get('name') ?? ''),
                regionCodes: data.getAll('regions').map(String),
                published: data.has('published'),
              });
              if (!mounted.current) return;
              setProfile(saved);
              setStatus('Профиль сохранён.');
            } catch (error) {
              if (!mounted.current) return;
              if (
                error instanceof ApiError &&
                [401, 403].includes(error.status)
              )
                denyAccess();
              else setStatus((error as Error).message);
            } finally {
              if (mounted.current) setSaving(false);
            }
          }}
        >
          <label>
            Публичное имя
            <input
              name="name"
              required
              maxLength={120}
              defaultValue={profile?.name}
            />
          </label>
          <label>
            Регионы работы
            <select
              name="regions"
              multiple
              size={6}
              defaultValue={profile?.regionCodes ?? []}
            >
              {regions.map(({ code, name }) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              name="published"
              defaultChecked={profile?.published ?? false}
            />{' '}
            Показывать в каталоге
          </label>
          <button type="submit" disabled={saving}>
            Сохранить профиль
          </button>
          {profile?.published && (
            <Link href={'/professionals/' + profile.id}>
              Открыть публичный профиль
            </Link>
          )}
        </form>
      )}
      {ready &&
        (profile ? (
          <ProfileImageEditor
            key={profile.id}
            path={path}
            agency={agency}
            imageId={profile.imageId ?? null}
            disabled={saving}
            onBusy={setSaving}
            onImage={(imageId) =>
              setProfile((current) =>
                current ? { ...current, imageId } : current,
              )
            }
            onDenied={denyAccess}
            onNoProfile={() => {
              setProfile(null);
              setSaving(false);
              setStatus('Профиль больше не доступен. Сохраните его заново.');
            }}
          />
        ) : (
          <p>
            {agency
              ? 'Сохраните профиль, чтобы добавить логотип агентства.'
              : 'Сохраните профиль, чтобы добавить фото агента.'}
          </p>
        ))}
      <p role="status">{status}</p>
    </details>
  );
}
