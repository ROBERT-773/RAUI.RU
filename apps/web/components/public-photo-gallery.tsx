'use client';

import Image from 'next/image';
import { useRef, useState } from 'react';
import styles from './public-photo-gallery.module.css';

type Photo = { src: string; width: number; height: number };

export default function PublicPhotoGallery({ photos }: { photos: Photo[] }) {
  const [selected, setSelected] = useState<string>();
  const touch = useRef<{ x: number; y: number } | null>(null);
  const index = Math.max(
    0,
    photos.findIndex((photo) => photo.src === selected),
  );
  const photo = photos[index];
  if (!photo) return null;
  const multiple = photos.length > 1;
  function move(step: number) {
    setSelected(photos[(index + step + photos.length) % photos.length]!.src);
  }
  return (
    <section
      className={styles.gallery}
      aria-label="Фотографии"
      onKeyDown={(event) => {
        if (!multiple || !['ArrowLeft', 'ArrowRight'].includes(event.key))
          return;
        event.preventDefault();
        move(event.key === 'ArrowRight' ? 1 : -1);
      }}
    >
      <Image
        className={`detail-photo ${styles.photo}`}
        src={photo.src}
        alt="Фото недвижимости"
        width={photo.width}
        height={photo.height}
        sizes="(max-width: 768px) 100vw, 64rem"
        loading="eager"
        unoptimized
        onTouchStart={(event) => {
          const point = event.touches[0];
          touch.current =
            multiple && event.touches.length === 1 && point
              ? { x: point.clientX, y: point.clientY }
              : null;
        }}
        onTouchCancel={() => {
          touch.current = null;
        }}
        onTouchEnd={(event) => {
          const start = touch.current;
          touch.current = null;
          const end = event.changedTouches[0];
          if (!start || !end) return;
          const dx = end.clientX - start.x;
          if (
            Math.abs(dx) >= 40 &&
            Math.abs(dx) > Math.abs(end.clientY - start.y)
          )
            move(dx < 0 ? 1 : -1);
        }}
      />
      {multiple && (
        <div className={styles.controls}>
          <button
            type="button"
            aria-label="Предыдущее фото"
            onClick={() => move(-1)}
          >
            ‹
          </button>
          <span aria-live="polite" aria-atomic="true">
            {index + 1} из {photos.length}
          </span>
          <button
            type="button"
            aria-label="Следующее фото"
            onClick={() => move(1)}
          >
            ›
          </button>
        </div>
      )}
    </section>
  );
}
