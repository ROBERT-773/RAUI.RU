'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/client';
import AgentPublicProfile from './agent-public-profile';
import AgencyMembers from './agency-members';
import ProfessionalFeedLinks from './professional-feed-links';

type Organization = {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  membership_role: string;
  membership_active: boolean;
};

export default function AgencyPublicProfiles({
  userId,
  canCreate,
  kind = 'agency',
  onVerifyContacts,
}: {
  userId: string;
  canCreate: boolean;
  kind?: 'developer' | 'agency';
  onVerifyContacts?: (() => void) | undefined;
}) {
  const [agencies, setAgencies] = useState<Organization[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const creation = useRef<{ name: string; key: string } | null>(null);
  const developer = kind === 'developer';
  const sectionName = developer ? 'Организации застройщика' : 'Агентства';
  useEffect(() => {
    let active = true;
    api<Organization[]>('v1/organizations')
      .then((organizations) => {
        if (!active) return;
        const manageable = organizations.filter(
          (item) => item.active && item.kind === kind && item.membership_active,
        );
        setAgencies(manageable);
        setSelectedId(manageable[0]?.id ?? '');
      })
      .catch(() => {
        if (active) setError('Не удалось загрузить организации.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [kind]);
  const selected = agencies.find(({ id }) => id === selectedId);
  async function createAgency() {
    if (creating || loading) return;
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError('Введите название организации от двух символов.');
      return;
    }
    setCreating(true);
    setError('');
    if (creation.current?.name !== trimmed)
      creation.current = { name: trimmed, key: crypto.randomUUID() };
    try {
      const organization = await api<Organization>(
        'v1/organizations',
        'POST',
        { name: trimmed, kind },
        { idempotencyKey: creation.current.key },
      );
      setAgencies((previous) => [
        { ...organization, membership_role: 'owner', membership_active: true },
        ...previous.filter(({ id }) => id !== organization.id),
      ]);
      setSelectedId(organization.id);
      setName('');
      creation.current = null;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Не удалось создать организацию.',
      );
    } finally {
      setCreating(false);
    }
  }
  return (
    <section id="agencies" aria-label={sectionName}>
      <h2>{sectionName}</h2>
      {loading && <p role="status">Загружаем организации…</p>}
      {error && <p role="alert">{error}</p>}
      {canCreate && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createAgency();
          }}
        >
          <label>
            {developer ? 'Название застройщика' : 'Название агентства'}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={200}
              disabled={creating}
            />
          </label>
          <button disabled={creating || loading}>
            {creating
              ? 'Создаём…'
              : developer
                ? 'Создать организацию'
                : 'Создать агентство'}
          </button>
        </form>
      )}
      {userId && !developer && (
        <details>
          <summary>Мой код для добавления в агентство</summary>
          <p>
            <code>{userId}</code>
          </p>
        </details>
      )}
      {selected && (
        <>
          <label>
            {developer ? 'Организация' : 'Агентство'}
            <select
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {agencies.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {!developer && (
            <>
              <Link
                href={`/account/listings?agency=${encodeURIComponent(selected.id)}#new-listing`}
              >
                Перейти к подаче объявления
              </Link>
              <AgencyMembers
                key={selectedId}
                agencyId={selectedId}
                userId={userId}
                role={selected.membership_role}
              />
            </>
          )}
          {['owner', 'admin'].includes(selected.membership_role) && (
            <>
              <ProfessionalFeedLinks
                key={'feeds-' + selected.id}
                organizationId={selected.id}
                onVerifyContacts={onVerifyContacts}
              />
              {!developer && (
                <AgentPublicProfile
                  key={`profile-${selectedId}`}
                  agencyId={selectedId}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
