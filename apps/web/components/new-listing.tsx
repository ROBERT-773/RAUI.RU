'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/client';
interface Category {
  code: string;
  name: string;
}
interface Attribute {
  code: string;
  name: string;
  kind: 'number' | 'string' | 'boolean' | 'enum';
  required: boolean;
  options: string[];
}
interface Attempt {
  property: unknown;
  listing: Record<string, unknown>;
  propertyKey: string;
  listingKey: string;
  propertyId?: string;
}
export default function NewListing({
  onCreated,
  onBusyChange,
  disabled = false,
}: {
  onCreated: (id: string) => void;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState('');
  const [definitions, setDefinitions] = useState<Attribute[] | null>(null);
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [region, setRegion] = useState('moscow');
  const [deal, setDeal] = useState('sale');
  const [address, setAddress] = useState('');
  const [locality, setLocality] = useState('');
  const [longitude, setLongitude] = useState('');
  const [latitude, setLatitude] = useState('');
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [completed, setCompleted] = useState(false);
  const mounted = useRef(false);
  const allowed = useRef(!disabled);
  useEffect(() => {
    allowed.current = !disabled;
  }, [disabled]);
  const [error, setError] = useState('');
  const attempt = useRef<Attempt | undefined>(undefined);
  const saving = useRef(false);
  const definitionRequest = useRef(0);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    const requests = definitionRequest;
    api<Category[]>('v1/categories')
      .then((value) => {
        if (active) setCategories(value);
      })
      .catch(() => {
        if (active)
          setError('Не удалось загрузить категории. Обновите страницу.');
      });
    return () => {
      active = false;
      mounted.current = false;
      requests.current++;
    };
  }, []);
  async function chooseCategory(value: string) {
    const request = ++definitionRequest.current;
    setCategory(value);
    setAttributes({});
    setDefinitions(null);
    setError('');
    if (!value) return;
    try {
      const result = await api<Attribute[]>(
        `v1/categories/${value}/attributes`,
      );
      if (request === definitionRequest.current) setDefinitions(result);
    } catch {
      if (request === definitionRequest.current)
        setError(
          'Не удалось загрузить характеристики. Выберите категорию ещё раз.',
        );
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving.current || !definitions || disabled || completed) return;
    if (!attempt.current) {
      const values: Record<string, string | number | boolean> = {};
      for (const field of definitions) {
        const value = attributes[field.code] ?? '';
        if (value === '') {
          if (field.required) {
            setError(`Заполните: ${field.name}`);
            return;
          }
          continue;
        }
        values[field.code] =
          field.kind === 'number'
            ? Number(value)
            : field.kind === 'boolean'
              ? value === 'true'
              : value;
      }
      if (
        !category ||
        !address.trim() ||
        !locality.trim() ||
        longitude.trim() === '' ||
        latitude.trim() === '' ||
        !Number.isFinite(Number(longitude)) ||
        !Number.isFinite(Number(latitude)) ||
        Number(longitude) < -180 ||
        Number(longitude) > 180 ||
        Number(latitude) < -90 ||
        Number(latitude) > 90 ||
        title.trim().length < 3 ||
        !Number.isFinite(Number(price)) ||
        Number(price) <= 0 ||
        Object.values(values).some(
          (v) => typeof v === 'number' && !Number.isFinite(v),
        ) ||
        (typeof values.area === 'number' && values.area <= 0)
      ) {
        setError(
          'Проверьте адрес, координаты, заголовок, цену и характеристики.',
        );
        return;
      }
      attempt.current = {
        property: {
          category,
          address: {
            formatted: address.trim(),
            locality: locality.trim(),
            regionCode: region,
            longitude: Number(longitude),
            latitude: Number(latitude),
          },
          attributes: values,
        },
        listing: {
          dealType: deal,
          title: title.trim(),
          price: Number(price),
          description,
        },
        propertyKey: crypto.randomUUID(),
        listingKey: crypto.randomUUID(),
      };
      setLocked(true);
    }
    saving.current = true;
    onBusyChange?.(true);
    setBusy(true);
    setError('');
    try {
      const current = attempt.current;
      if (!current.propertyId) {
        const property = await api<{ id: string }>(
          'v1/properties',
          'POST',
          current.property,
          { idempotencyKey: current.propertyKey },
        );
        current.propertyId = property.id;
      }
      if (!mounted.current || !allowed.current) return;
      const listing = await api<{ id: string }>(
        'v1/listings',
        'POST',
        { ...current.listing, propertyId: current.propertyId },
        { idempotencyKey: current.listingKey },
      );
      if (mounted.current) {
        setCompleted(true);
        onCreated(listing.id);
      }
    } catch {
      if (mounted.current)
        setError(
          'Не удалось сохранить черновик. Повторите сохранение: уже созданный объект будет использован повторно.',
        );
    } finally {
      saving.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  function reset() {
    if (saving.current || disabled) return;
    attempt.current = undefined;
    setLocked(false);
    setCompleted(false);
    setError('');
    setAttributes({});
    setAddress('');
    setLocality('');
    setLongitude('');
    setLatitude('');
    setTitle('');
    setPrice('');
    setDescription('');
  }
  return (
    <form onSubmit={save}>
      <h2>Новое объявление</h2>
      <p>
        Сохраните черновик, затем добавьте фотографии и отправьте объявление на
        проверку.
      </p>
      <fieldset disabled={locked || busy || disabled}>
        <legend>Объект и условия</legend>
        <label>
          Регион
          <select
            value={region}
            onChange={(event) => setRegion(event.target.value)}
          >
            <option value="moscow">Москва</option>
            <option value="moscow_oblast">Московская область</option>
          </select>
        </label>
        <label>
          Категория
          <select
            value={category}
            onChange={(event) => void chooseCategory(event.target.value)}
            required
          >
            <option value="">Выберите категорию</option>
            {categories.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Сделка
          <select
            value={deal}
            onChange={(event) => setDeal(event.target.value)}
          >
            <option value="sale">Продажа</option>
            <option value="long_rent">Долгосрочная аренда</option>
            <option value="short_rent">Посуточная аренда</option>
          </select>
        </label>
        <label>
          Адрес
          <input
            required
            minLength={3}
            maxLength={500}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <label>
          Населённый пункт
          <input
            required
            maxLength={100}
            value={locality}
            onChange={(event) => setLocality(event.target.value)}
          />
        </label>
        <p>
          Укажите координаты реального объекта: долготу и широту можно
          скопировать из карты.
        </p>
        <label>
          Долгота
          <input
            required
            type="number"
            step="any"
            min={-180}
            max={180}
            value={longitude}
            onChange={(event) => setLongitude(event.target.value)}
          />
        </label>
        <label>
          Широта
          <input
            required
            type="number"
            step="any"
            min={-90}
            max={90}
            value={latitude}
            onChange={(event) => setLatitude(event.target.value)}
          />
        </label>
        {definitions?.map((field) => (
          <label key={field.code}>
            {field.name}
            {field.required ? ' *' : ''}
            {field.kind === 'enum' || field.kind === 'boolean' ? (
              <select
                required={field.required}
                value={attributes[field.code] ?? ''}
                onChange={(event) =>
                  setAttributes((current) => ({
                    ...current,
                    [field.code]: event.target.value,
                  }))
                }
              >
                <option value="">Не указано</option>
                {(field.kind === 'boolean'
                  ? ['true', 'false']
                  : field.options
                ).map((option) => (
                  <option key={option} value={option}>
                    {field.kind === 'boolean'
                      ? option === 'true'
                        ? 'Да'
                        : 'Нет'
                      : option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                required={field.required}
                type={field.kind === 'number' ? 'number' : 'text'}
                step={field.kind === 'number' ? 'any' : undefined}
                maxLength={field.kind === 'string' ? 2000 : undefined}
                value={attributes[field.code] ?? ''}
                onChange={(event) =>
                  setAttributes((current) => ({
                    ...current,
                    [field.code]: event.target.value,
                  }))
                }
              />
            )}
          </label>
        ))}
        <label>
          Заголовок
          <input
            required
            minLength={3}
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Цена, ₽
          <input
            required
            type="number"
            min={0.01}
            max={99999999999999}
            step="0.01"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
        </label>
        <label>
          Описание
          <textarea
            maxLength={10000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {locked && !completed && (
        <p>
          Сохранение начато. Поля зафиксированы до завершения; после сохранения
          их можно изменить в черновике.
        </p>
      )}
      {!completed && (
        <button disabled={busy || !definitions || disabled} type="submit">
          {busy
            ? 'Сохраняем…'
            : locked
              ? 'Повторить сохранение'
              : 'Сохранить черновик'}
        </button>
      )}
      {completed && (
        <>
          <p role="status">
            Черновик сохранён. Добавьте фотографии и отправьте его на проверку.
          </p>
          <button type="button" disabled={busy || disabled} onClick={reset}>
            Создать ещё объявление
          </button>
        </>
      )}
    </form>
  );
}
