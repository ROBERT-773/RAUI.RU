'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/client';

type Profile = {
  id: string;
  name: string;
  regionCodes: string[];
  published: boolean;
};

export default function AgentPublicProfile({
  agencyId,
}: {
  agencyId?: string;
}) {
  const path = agencyId
    ? 'v1/search/professional-profile/agency/' + encodeURIComponent(agencyId)
    : 'v1/search/professional-profile';
  const [profile, setProfile] = useState<Profile | null>(null);
  const [regions, setRegions] = useState<{ code: string; name: string }[]>([]);
  const [status, setStatus] = useState('Загружаем профиль…');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
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
      .catch(() => {
        if (active) setStatus('Не удалось загрузить настройки профиля.');
      });
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <details>
      <summary>
        {agencyId ? 'Публичный профиль агентства' : 'Публичный профиль агента'}
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
              setProfile(saved);
              setStatus('Профиль сохранён.');
            } catch (error) {
              setStatus((error as Error).message);
            } finally {
              setSaving(false);
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
      <p role="status">{status}</p>
    </details>
  );
}
