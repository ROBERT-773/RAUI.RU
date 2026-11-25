'use client';
import Image from 'next/image';
import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../lib/client';
import styles from './professional-identity.module.css';

const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
const fileHint = 'JPG, PNG или WebP, до 10 МБ.';

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

type Props = {
  path: string;
  agency: boolean;
  imageId: string | null;
  disabled: boolean;
  onBusy: (value: boolean) => void;
  onImage: (id: string | null) => void;
  onDenied: () => void;
  onNoProfile: () => void;
};
export default function ProfileImageEditor({
  path,
  agency,
  imageId,
  disabled,
  onBusy,
  onImage,
  onDenied,
  onNoProfile,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const titleId = useId(),
    hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const active = useRef(false),
    running = useRef(false);
  const label = agency ? 'Логотип агентства' : 'Фото агента';
  const imagePath = path + '/image';
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (disabled || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement === document.body)
      (retry.current ?? input.current)?.focus();
  }, [disabled]);

  function clearFile() {
    setFile(null);
    if (input.current) input.current.value = '';
  }
  async function refresh() {
    try {
      const value = await api<{ profile: { imageId?: string | null } | null }>(
        path,
      );
      if (!active.current) return;
      if (value.profile === null) {
        onNoProfile();
        return;
      }
      onImage(value.profile.imageId ?? null);
      setNeedsRefresh(false);
    } catch (failure) {
      if (!active.current) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
        onDenied();
        return;
      }
      setNeedsRefresh(true);
      setError('Не удалось проверить текущее изображение. Повторите проверку.');
    }
  }
  async function change(action: 'upload' | 'remove' | 'refresh') {
    if (disabled || running.current) return;
    restoreFocus.current = Boolean(
      input.current?.form?.contains(document.activeElement),
    );
    running.current = true;
    onBusy(true);
    setStatus('');
    setError('');
    try {
      if (action === 'refresh') {
        await refresh();
        return;
      }
      let result: { imageId: string | null };
      if (action === 'upload') {
        if (!file) return;
        let base64: string;
        try {
          base64 = await readImage(file);
        } catch {
          if (active.current) {
            clearFile();
            setError('Не удалось прочитать файл. Выберите его снова.');
          }
          return;
        }
        if (!active.current) return;
        result = await api(imagePath, 'PUT', {
          filename: file.name,
          mime: file.type,
          base64,
          expectedImageId: imageId,
        });
      } else {
        if (!imageId) return;
        result = await api(
          imagePath + '/' + encodeURIComponent(imageId),
          'DELETE',
        );
      }
      if (!active.current) return;
      onImage(result.imageId);
      clearFile();
      setStatus(
        action === 'remove' ? 'Изображение удалено.' : 'Изображение сохранено.',
      );
    } catch (failure) {
      if (!active.current) return;
      if (failure instanceof ApiError) {
        if (failure.status === 401 || failure.status === 403) {
          onDenied();
          return;
        }
        if (
          failure.status === 400 ||
          failure.status === 413 ||
          failure.status === 415 ||
          failure.status === 422
        ) {
          setError('Файл не принят. Выберите другое изображение. ' + fileHint);
          return;
        }
      }
      clearFile();
      setError(
        failure instanceof ApiError && [404, 409].includes(failure.status)
          ? 'Изображение уже изменилось. Проверьте текущую версию перед следующим действием.'
          : 'Не удалось подтвердить изменение. Проверьте текущее изображение перед повтором.',
      );
      await refresh();
    } finally {
      running.current = false;
      if (active.current) onBusy(false);
    }
  }
  return (
    <section className={styles.imageEditor} aria-labelledby={titleId}>
      <h3 id={titleId}>{label}</h3>
      {imageId && (
        <Image
          className={agency ? styles.logo : styles.portrait}
          width={80}
          height={80}
          src={'/api/' + imagePath + '/' + encodeURIComponent(imageId)}
          alt={label}
          unoptimized
        />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void change('upload');
        }}
      >
        <label>
          Файл изображения
          <input
            ref={input}
            type="file"
            aria-describedby={hintId}
            accept={allowedTypes.join(',')}
            disabled={disabled || needsRefresh}
            onChange={(event) => {
              const next = event.target.files?.[0] ?? null;
              setStatus('');
              setError('');
              if (
                next &&
                (!allowedTypes.includes(next.type) ||
                  next.size < 1 ||
                  next.size > 10 * 1024 * 1024)
              ) {
                clearFile();
                setError('Выберите непустое изображение. ' + fileHint);
                return;
              }
              setFile(next);
            }}
          />
        </label>
        <p id={hintId}>{fileHint}</p>
        <div className={styles.imageActions}>
          <button type="submit" disabled={disabled || !file || needsRefresh}>
            {imageId ? 'Заменить' : 'Загрузить'} {agency ? 'логотип' : 'фото'}
          </button>
          {imageId && (
            <button
              type="button"
              disabled={disabled || needsRefresh}
              onClick={() => void change('remove')}
            >
              {agency ? 'Удалить логотип' : 'Удалить фото'}
            </button>
          )}
          {needsRefresh && (
            <button
              ref={retry}
              type="button"
              disabled={disabled}
              onClick={() => void change('refresh')}
            >
              Проверить текущее изображение
            </button>
          )}
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
