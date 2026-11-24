'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import Link from 'next/link';
import { api, ApiError } from '../lib/client';
import {
  commercialLand,
  listingAreaError,
  listingAttributeName,
  listingAttributeFields,
} from '../lib/listing-attribute-fields';
import ListingTermsFields, { type ListingTerms } from './listing-terms';
import {
  ListingFormDrafts,
  sameListingForm,
  type AccountListingDraft,
  type ListingForm,
} from './listing-form-drafts';
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
interface Organization {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  membership_active: boolean;
}
interface AddressSuggestion {
  formatted: string;
  locality: string;
  regionCode?: string;
  longitude: number;
  latitude: number;
}
const steps = ['Сделка', 'Расположение', 'Характеристики', 'Цена и условия'];
const defaultRegions = [
  { code: 'moscow', name: 'Москва' },
  { code: 'moscow_oblast', name: 'Московская область' },
];

export default function NewListing({
  onCreated,
  onBusyChange,
  sellerRole,
  initialAgencyId = '',
  regions = defaultRegions,
  disabled = false,
}: {
  onCreated: (id: string) => void;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  sellerRole?: string;
  initialAgencyId?: string;
  regions?: { code: string; name: string }[];
}) {
  const canRepresentAgency = sellerRole === 'agent' || sellerRole === 'agency';
  const requiresAgency = sellerRole === 'agency';
  const [agencies, setAgencies] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState(initialAgencyId);
  const [agencyStatus, setAgencyStatus] = useState<
    'loading' | 'ready' | 'error'
  >('loading');
  const [agencyRequest, setAgencyRequest] = useState(0);
  useEffect(() => {
    if (!canRepresentAgency) return;
    let active = true;
    api<Organization[]>('v1/organizations')
      .then((items) => {
        if (!active) return;
        setAgencies(
          items.filter(
            (item) =>
              item.kind === 'agency' && item.active && item.membership_active,
          ),
        );
        setAgencyStatus('ready');
      })
      .catch(() => {
        if (active) setAgencyStatus('error');
      });
    return () => {
      active = false;
    };
  }, [canRepresentAgency, agencyRequest]);
  const selectedAgency =
    canRepresentAgency && agencyStatus === 'ready'
      ? requiresAgency &&
        agencies.length === 1 &&
        (!organizationId || organizationId === agencies[0]!.id)
        ? agencies[0]
        : agencies.find(({ id }) => id === organizationId)
      : undefined;
  const needsAgencyChoice =
    canRepresentAgency &&
    (requiresAgency || Boolean(organizationId)) &&
    !selectedAgency;
  const lostAgency =
    agencyStatus === 'ready' && Boolean(organizationId) && !selectedAgency;
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState('');
  const [definitions, setDefinitions] = useState<Attribute[] | null>(null);
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const isCommercialLand =
    category === 'commercial' &&
    attributes.commercial_property_type === commercialLand;
  const visibleDefinitions = listingAttributeFields(
    category,
    definitions ?? [],
    attributes.commercial_property_type,
  );
  const commercialTypeField =
    category === 'commercial'
      ? definitions?.find(
          (field) =>
            field.code === 'commercial_property_type' && field.kind === 'enum',
        )
      : undefined;
  const regionOptions = regions.length ? regions : defaultRegions;
  const [region, setRegion] = useState(
    regionOptions.find(({ code }) => code === 'moscow')?.code ??
      regionOptions[0]!.code,
  );
  const regionName = regionOptions.find(({ code }) => code === region)?.name;
  const [deal, setDeal] = useState('sale');
  const [terms, setTerms] = useState<ListingTerms>({});
  const [address, setAddress] = useState('');
  const [locality, setLocality] = useState('');
  const [addressLookup, setAddressLookup] = useState<{
    query: string;
    pending: boolean;
    suggestions?: AddressSuggestion[];
    message?: string;
  }>();
  const [longitude, setLongitude] = useState('');
  const [latitude, setLatitude] = useState('');
  const longitudeValue = Number(longitude);
  const latitudeValue = Number(latitude);
  const validLocation =
    address.trim().length >= 3 &&
    locality.trim().length > 0 &&
    longitude.trim().length > 0 &&
    latitude.trim().length > 0 &&
    longitudeValue >= -180 &&
    longitudeValue <= 180 &&
    latitudeValue >= -90 &&
    latitudeValue <= 90;
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [step, setStep] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    form.current
      ?.querySelector<HTMLElement>('fieldset:not([hidden]) > legend')
      ?.focus();
  }, [step]);
  const mounted = useRef(false);
  const allowed = useRef(!disabled);
  useEffect(() => {
    allowed.current = !disabled;
  }, [disabled]);
  const [error, setError] = useState('');
  const attempt = useRef<Attempt | undefined>(undefined);
  const saving = useRef(false);
  const definitionRequest = useRef(0);
  const addressRequest = useRef(0);
  const [coordinatesFromSuggestion, setCoordinatesFromSuggestion] =
    useState(false);
  const [drafts, setDrafts] = useState<AccountListingDraft[]>([]);
  const [activeDraft, setActiveDraft] = useState<AccountListingDraft | null>(
    null,
  );
  const [draftListFailed, setDraftListFailed] = useState(false);
  const [draftNotice, setDraftNotice] = useState('');
  const [draftConflict, setDraftConflict] = useState(false);
  const draftListRequest = useRef(0);
  const pendingDraftId = useRef('');
  const touched = useRef(false);
  const formData: ListingForm = {
    step,
    category,
    deal,
    region,
    organizationId: selectedAgency?.id ?? organizationId,
    locality,
    address,
    longitude,
    latitude,
    ...(coordinatesFromSuggestion ? { coordinatesFromSuggestion: true } : {}),
    attributes,
    title,
    price,
    terms,
  };
  const reloadDrafts = useCallback(() => {
    const request = ++draftListRequest.current;
    return api<AccountListingDraft[]>('v1/account/listing-drafts')
      .then((records) => {
        if (!mounted.current || request !== draftListRequest.current) return;
        setDrafts(records);
        setDraftListFailed(false);
      })
      .catch(() => {
        if (mounted.current && request === draftListRequest.current)
          setDraftListFailed(true);
      });
  }, []);
  async function persistDraft(base = activeDraft) {
    if (!pendingDraftId.current) pendingDraftId.current = crypto.randomUUID();
    const id = base?.id ?? pendingDraftId.current;
    const record = await api<AccountListingDraft>(
      `v1/account/listing-drafts/${id}`,
      'PUT',
      {
        version: base?.version ?? 0,
        form: formData,
      },
    );
    if (mounted.current) {
      draftListRequest.current++;
      setActiveDraft(record);
      setDraftConflict(false);
      setDrafts((previous) => [
        record,
        ...previous.filter((item) => item.id !== record.id),
      ]);
      touched.current = false;
      void reloadDrafts();
    }
    return record;
  }
  function handleDraftError(failure: unknown) {
    if (failure instanceof ApiError && failure.status === 401) {
      setSessionExpired(true);
      setError(
        'Сессия завершилась. Скопируйте нужные данные перед повторным входом.',
      );
    } else if (
      failure instanceof ApiError &&
      (failure.status === 404 || failure.status === 409)
    ) {
      setLocked(false);
      attempt.current = undefined;
      setDraftConflict(true);
      setError(
        'Черновик изменился или уже завершён. Проверьте список незавершённых объявлений. Введённые данные остались в форме.',
      );
      void reloadDrafts();
    } else {
      setError(
        'Не удалось сохранить форму в кабинете. Введённые данные остались здесь. Повторите сохранение.',
      );
    }
  }
  async function saveIncomplete(asCopy = false) {
    if (saving.current || disabled || locked || completed || sessionExpired)
      return;
    saving.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    setDraftNotice('');
    if (asCopy) {
      pendingDraftId.current = crypto.randomUUID();
      setActiveDraft(null);
      setDraftConflict(false);
    }
    try {
      await persistDraft(asCopy ? null : activeDraft);
      if (mounted.current)
        setDraftNotice(
          'Черновик сохранён в кабинете. Можно продолжить сейчас или вернуться позже.',
        );
    } catch (failure) {
      if (mounted.current) handleDraftError(failure);
    } finally {
      saving.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  function invalidateAddressLookup() {
    addressRequest.current++;
    setAddressLookup(undefined);
    if (!coordinatesFromSuggestion) return;
    setCoordinatesFromSuggestion(false);
    setLongitude('');
    setLatitude('');
  }
  const addressQuery = [
    regionOptions.find(({ code }) => code === region)?.name,
    locality.trim(),
    address.trim(),
  ]
    .filter(Boolean)
    .join(', ');
  const currentLookup =
    addressLookup?.query === addressQuery ? addressLookup : undefined;
  async function lookupAddress() {
    const request = ++addressRequest.current;
    setAddressLookup({ query: addressQuery, pending: true });
    try {
      const matches = await api<AddressSuggestion[]>(
        'v1/geo/geocode?' + new URLSearchParams({ q: addressQuery }),
      );
      if (!mounted.current || request !== addressRequest.current) return;
      const suggestions = matches.filter(
        (match) => !match.regionCode || match.regionCode === region,
      );
      setAddressLookup({
        query: addressQuery,
        pending: false,
        suggestions,
        ...(!suggestions.length
          ? {
              message:
                'Адрес не найден. Уточните его или введите координаты вручную.',
            }
          : {}),
      });
    } catch {
      if (mounted.current && request === addressRequest.current)
        setAddressLookup({
          query: addressQuery,
          pending: false,
          message: 'Поиск адресов недоступен. Координаты можно ввести вручную.',
        });
    }
  }
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void reloadDrafts();
    const requests = definitionRequest;
    const formRequests = draftListRequest;
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
      formRequests.current++;
    };
  }, [reloadDrafts]);
  async function chooseCategory(
    value: string,
    initialAttributes: Record<string, string> = {},
  ) {
    const request = ++definitionRequest.current;
    setCategory(value);
    setAttributes(initialAttributes);
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
    if (saving.current || disabled || completed || sessionExpired) return;
    if (!locked && needsAgencyChoice) {
      setError(
        'На первом шаге выберите, от чьего имени разместить объявление.',
      );
      return;
    }
    if (!locked && step >= 2) {
      const missingField = visibleDefinitions.find(
        ({ code, required }) => required && !attributes[code]?.trim(),
      );
      if (missingField) {
        setError(
          `Заполните: ${listingAttributeName(missingField, isCommercialLand)}`,
        );
        return;
      }
      const areaError = listingAreaError(
        visibleDefinitions,
        attributes,
        isCommercialLand,
      );
      if (areaError) {
        setError(areaError);
        return;
      }
    }
    if (!locked) {
      if (
        (step === 0 || step === steps.length - 1) &&
        commercialTypeField?.required &&
        !commercialTypeField.options.includes(
          attributes.commercial_property_type ?? '',
        )
      ) {
        setError('Выберите тип коммерческого объекта.');
        return;
      }
      if (
        step >= 2 &&
        visibleDefinitions.some(({ code }) => code === 'kitchen_area') &&
        attributes.kitchen_area &&
        (Number(attributes.kitchen_area) < 0 ||
          (attributes.area &&
            Number(attributes.kitchen_area) > Number(attributes.area)))
      ) {
        setError('Площадь кухни должна быть от нуля до общей площади объекта.');
        return;
      }
      if (
        step >= 2 &&
        visibleDefinitions.some(({ code }) => code === 'floor') &&
        visibleDefinitions.some(({ code }) => code === 'floors') &&
        attributes.floor &&
        attributes.floors &&
        Number(attributes.floor) > Number(attributes.floors)
      ) {
        setError('Этаж не может быть больше количества этажей в доме.');
        return;
      }
      if (step < steps.length - 1) {
        if (step === 0 && (!category || !definitions)) return;
        if (step === 1 && !validLocation) {
          setError(
            'Укажите адрес, населённый пункт и корректные координаты объекта.',
          );
          return;
        }
        setError('');
        setDraftNotice('');
        setStep(step + 1);
        return;
      }
    }
    if (!definitions) return;
    if (!attempt.current) {
      const values: Record<string, string | number | boolean> = {};
      for (const field of visibleDefinitions) {
        const value = attributes[field.code] ?? '';
        if (!value.trim()) continue;
        values[field.code] =
          field.kind === 'number'
            ? Number(value)
            : field.kind === 'boolean'
              ? value === 'true'
              : value;
      }
      const listingTitle = title.trim();
      const listingPrice = Number(price);
      if (listingTitle.length < 3) {
        setError('Введите заголовок длиной не менее трёх символов.');
        return;
      }
      if (!Number.isFinite(listingPrice) || listingPrice <= 0) {
        setError('Укажите цену больше нуля.');
        return;
      }
      if (!validLocation) {
        setError('Проверьте адрес, населённый пункт и координаты объекта.');
        return;
      }
      if (
        !category ||
        Object.values(values).some(
          (v) => typeof v === 'number' && !Number.isFinite(v),
        )
      ) {
        setError('Проверьте характеристики объекта.');
        return;
      }
      attempt.current = {
        property: {
          category,
          ...(selectedAgency ? { organizationId: selectedAgency.id } : {}),
          address: {
            formatted: address.trim(),
            locality: locality.trim(),
            regionCode: region,
            longitude: longitudeValue,
            latitude: latitudeValue,
          },
          attributes: values,
        },
        listing: {
          dealType: deal,
          title: listingTitle,
          price: listingPrice,
          ...(Object.keys(terms).length
            ? {
                terms: Object.fromEntries(
                  Object.entries(terms).sort(([a], [b]) => a.localeCompare(b)),
                ),
              }
            : {}),
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
      if (activeDraft && !current.listing.formDraft) {
        let record: AccountListingDraft;
        try {
          record = await persistDraft();
        } catch (failure) {
          if (mounted.current) {
            attempt.current = undefined;
            setLocked(false);
            handleDraftError(failure);
          }
          return;
        }
        if (!mounted.current || !allowed.current) return;
        current.listing.formDraft = { id: record.id, version: record.version };
        current.listing.property = current.property;
        current.listingKey = `draft-listing-${record.id}-${record.version}`;
      }
      if (!current.listing.formDraft && !current.propertyId) {
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
        current.listing.formDraft
          ? current.listing
          : { ...current.listing, propertyId: current.propertyId },
        { idempotencyKey: current.listingKey },
      );
      if (mounted.current) {
        if (activeDraft) {
          draftListRequest.current++;
          setDrafts((previous) =>
            previous.filter((draft) => draft.id !== activeDraft.id),
          );
          setActiveDraft(null);
          pendingDraftId.current = '';
        }
        setDraftNotice('');
        setCompleted(true);
        onCreated(listing.id);
      }
    } catch (error) {
      if (!mounted.current) return;
      if (
        activeDraft &&
        error instanceof ApiError &&
        [404, 409].includes(error.status)
      ) {
        handleDraftError(error);
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        setSessionExpired(true);
        setError(
          'Сессия завершилась. Скопируйте нужные данные перед повторным входом.',
        );
        return;
      }
      if (
        selectedAgency &&
        !attempt.current?.propertyId &&
        error instanceof ApiError &&
        error.status === 403
      ) {
        attempt.current = undefined;
        setLocked(false);
        setAgencyStatus('loading');
        setAgencyRequest((value) => value + 1);
        setStep(0);
        setError(
          'Не удалось подать объявление от выбранного агентства. Проверьте доступ или выберите другое. Введённые данные сохранены в форме.',
        );
      } else {
        setError(
          selectedAgency && error instanceof ApiError && error.status === 403
            ? 'Объект сохранён. Проверьте доступ к агентству и повторите сохранение объявления после восстановления доступа.'
            : activeDraft
              ? 'Не удалось перейти к фотографиям. Повторите попытку. Сохранённый черновик доступен в кабинете.'
              : 'Не удалось сохранить черновик. Повторите сохранение: уже созданный объект будет использован повторно.',
        );
      }
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
    setSessionExpired(false);
    setCompleted(false);
    setActiveDraft(null);
    setDraftConflict(false);
    pendingDraftId.current = '';
    touched.current = false;
    setDraftNotice('');
    setStep(0);
    setError('');
    void chooseCategory('');
    setDeal('sale');
    setRegion(
      regionOptions.find(({ code }) => code === 'moscow')?.code ??
        regionOptions[0]!.code,
    );
    setAddress('');
    invalidateAddressLookup();
    setLocality('');
    setLongitude('');
    setLatitude('');
    setTitle('');
    setPrice('');
    setTerms({});
    setOrganizationId(initialAgencyId);
  }
  function mayLeaveForm() {
    const changed = activeDraft
      ? !sameListingForm(formData, activeDraft.form)
      : touched.current;
    return (
      !changed ||
      completed ||
      window.confirm(
        'В форме есть несохранённые изменения. Перейти без их сохранения?',
      )
    );
  }
  function resumeDraft(record: AccountListingDraft) {
    if (saving.current || disabled || (locked && !completed) || !mayLeaveForm())
      return;
    const saved = record.form;
    attempt.current = undefined;
    setLocked(false);
    setCompleted(false);
    setSessionExpired(false);
    setDraftNotice('');
    setActiveDraft(record);
    setDraftConflict(false);
    pendingDraftId.current = record.id;
    touched.current = false;
    invalidateAddressLookup();
    void chooseCategory(saved.category, saved.attributes);
    setDeal(saved.deal);
    setOrganizationId(saved.organizationId);
    setRegion(saved.region);
    setAddress(saved.address);
    setLocality(saved.locality);
    setLongitude(saved.longitude);
    setLatitude(saved.latitude);
    setCoordinatesFromSuggestion(saved.coordinatesFromSuggestion === true);
    setPrice(saved.price);
    setTitle(saved.title);
    setTerms(saved.terms);
    setStep(saved.step);
    if (step === saved.step)
      form.current
        ?.querySelector<HTMLElement>('fieldset:not([hidden]) > legend')
        ?.focus();
  }
  return (
    <form
      ref={form}
      id="new-listing"
      className="listing-wizard"
      onSubmit={save}
      onChange={() => {
        touched.current = true;
        setDraftNotice('');
      }}
    >
      <h2>Новое объявление</h2>
      {step > 0 &&
        !completed &&
        !locked &&
        needsAgencyChoice &&
        agencyStatus !== 'loading' && (
          <p role="status">
            Проверьте, от чьего имени размещается это объявление.{' '}
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => {
                setStep(0);
                setError('');
              }}
            >
              Изменить выбор на первом шаге
            </button>
          </p>
        )}
      <ListingFormDrafts
        drafts={drafts}
        categories={categories}
        steps={steps}
        failed={draftListFailed}
        disabled={disabled || busy || sessionExpired || (locked && !completed)}
        onResume={resumeDraft}
        onRetry={() => void reloadDrafts()}
      />
      <p>
        Черновик можно сохранить на любом шаге. После заполнения цены и условий
        перейдите к фотографиям.
      </p>
      {!completed && (
        <ol
          className="listing-wizard-steps"
          aria-label="Шаги создания объявления"
        >
          {steps.map((name, index) => (
            <li key={name} aria-current={index === step ? 'step' : undefined}>
              {index + 1}. {name}
            </li>
          ))}
        </ol>
      )}
      <fieldset
        hidden={step !== 0 || completed}
        disabled={step !== 0 || locked || busy || disabled || completed}
      >
        <legend tabIndex={-1}>Сделка и объект</legend>
        {canRepresentAgency && (
          <>
            {agencyStatus === 'loading' && (
              <p role="status">Загружаем агентства…</p>
            )}
            {agencyStatus === 'error' && (
              <>
                <p role="alert">Не удалось загрузить агентства.</p>
                <button
                  type="button"
                  onClick={() => {
                    setAgencyStatus('loading');
                    setAgencyRequest((value) => value + 1);
                  }}
                >
                  Повторить загрузку
                </button>
              </>
            )}
            {agencyStatus === 'ready' &&
              (requiresAgency ||
                agencies.length > 0 ||
                lostAgency ||
                activeDraft?.form.organizationId) && (
                <label>
                  От чьего имени
                  <select
                    value={
                      selectedAgency?.id ??
                      (requiresAgency || lostAgency ? '' : 'personal')
                    }
                    required={requiresAgency}
                    onChange={(event) =>
                      setOrganizationId(
                        event.target.value === 'personal'
                          ? ''
                          : event.target.value,
                      )
                    }
                  >
                    {(requiresAgency || lostAgency) && (
                      <option value="" disabled>
                        {lostAgency
                          ? 'Ранее выбранное агентство недоступно'
                          : 'Выберите агентство'}
                      </option>
                    )}
                    {!requiresAgency && (
                      <option value="personal">От своего имени</option>
                    )}
                    {agencies.map(({ id, name }) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            {requiresAgency &&
              agencyStatus === 'ready' &&
              agencies.length === 0 && (
                <p>
                  Чтобы подать объявление,{' '}
                  <Link href="/account#agencies">
                    создайте агентство в кабинете
                  </Link>{' '}
                  или получите доступ к существующему.
                </p>
              )}
          </>
        )}
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
        {commercialTypeField && (
          <label>
            {commercialTypeField.name}
            {commercialTypeField.required ? ' *' : ''}
            <select
              required={commercialTypeField.required}
              value={attributes.commercial_property_type ?? ''}
              onChange={(event) =>
                setAttributes((current) => ({
                  ...current,
                  commercial_property_type: event.target.value,
                }))
              }
            >
              <option value="">Выберите тип объекта</option>
              {commercialTypeField.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Сделка
          <select
            value={deal}
            onChange={(event) => {
              setDeal(event.target.value);
              setTerms({});
            }}
          >
            <option value="sale">Продажа</option>
            <option value="long_rent">Долгосрочная аренда</option>
            <option value="short_rent">Посуточная аренда</option>
          </select>
        </label>
      </fieldset>
      <fieldset
        hidden={step !== 1 || completed}
        disabled={step !== 1 || locked || busy || disabled || completed}
      >
        <legend tabIndex={-1}>Расположение</legend>
        <p>
          Адрес можно уточнить при следующем заполнении. Он закрепится за
          объявлением, когда вы нажмёте «Перейти к фотографиям».
        </p>
        <label>
          Регион
          <select
            value={region}
            onChange={(event) => {
              invalidateAddressLookup();
              setRegion(event.target.value);
            }}
          >
            {regionOptions.map(({ code, name }) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Адрес
          <input
            required
            minLength={3}
            maxLength={500}
            value={address}
            onChange={(event) => {
              invalidateAddressLookup();
              setAddress(event.target.value);
            }}
          />
        </label>
        <label>
          Населённый пункт
          <input
            required
            maxLength={100}
            value={locality}
            onChange={(event) => {
              invalidateAddressLookup();
              setLocality(event.target.value);
            }}
          />
        </label>
        <button
          type="button"
          disabled={
            address.trim().length < 3 ||
            addressQuery.length > 300 ||
            currentLookup?.pending
          }
          onClick={() => void lookupAddress()}
        >
          {currentLookup?.pending ? 'Ищем адрес…' : 'Найти адрес'}
        </button>
        {currentLookup?.message && <p role="status">{currentLookup.message}</p>}
        {!!currentLookup?.suggestions?.length && (
          <ul aria-label="Найденные адреса">
            {currentLookup.suggestions.map((match, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => {
                    setAddress(match.formatted);
                    setLocality(match.locality);
                    setLongitude(String(match.longitude));
                    setLatitude(String(match.latitude));
                    setCoordinatesFromSuggestion(true);
                    setAddressLookup(undefined);
                  }}
                >
                  {match.formatted}
                </button>
              </li>
            ))}
          </ul>
        )}
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
            onChange={(event) => {
              setCoordinatesFromSuggestion(false);
              setLongitude(event.target.value);
            }}
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
            onChange={(event) => {
              setCoordinatesFromSuggestion(false);
              setLatitude(event.target.value);
            }}
          />
        </label>
      </fieldset>
      <fieldset
        hidden={step !== 2 || completed}
        disabled={step !== 2 || locked || busy || disabled || completed}
      >
        <legend tabIndex={-1}>Характеристики объекта</legend>
        {visibleDefinitions
          .filter((field) => field !== commercialTypeField)
          .map((field) => (
            <label key={field.code}>
              {listingAttributeName(field, isCommercialLand)}
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
                  min={
                    field.code === 'kitchen_area'
                      ? 0
                      : field.code === 'land_area'
                        ? 0.01
                        : undefined
                  }
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
              {field.code === 'kitchen_area' && (
                <small>Укажите 0, если отдельной кухни нет.</small>
              )}
            </label>
          ))}
      </fieldset>
      <fieldset
        hidden={step !== 3 || completed}
        disabled={step !== 3 || locked || busy || disabled || completed}
      >
        <legend tabIndex={-1}>Цена и условия</legend>
        {selectedAgency && <p>Агентство: {selectedAgency.name}</p>}
        {regionName && <p>Регион: {regionName}</p>}
        <p>Адрес объекта: {address.trim()}</p>
        <button
          type="button"
          onClick={() => {
            setError('');
            setStep(1);
          }}
        >
          Исправить адрес
        </button>
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
          {deal === 'long_rent'
            ? 'Цена, ₽ в месяц'
            : deal === 'short_rent'
              ? 'Цена, ₽ за сутки'
              : 'Цена, ₽'}
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
        <ListingTermsFields deal={deal} terms={terms} onChange={setTerms} />
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {draftNotice && <p role="status">{draftNotice}</p>}
      {sessionExpired && (
        <Link href="/account?action=publish">Войти снова</Link>
      )}
      {locked && !completed && !sessionExpired && (
        <p>
          Сохранение начато. Поля зафиксированы до завершения; после сохранения
          их можно изменить в черновике.
        </p>
      )}
      {!completed && (
        <div className="actions">
          {!locked && !sessionExpired && (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => void saveIncomplete(draftConflict)}
            >
              {draftConflict
                ? 'Сохранить отдельным черновиком'
                : 'Сохранить в черновики'}
            </button>
          )}
          {activeDraft && !locked && !sessionExpired && (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => {
                if (mayLeaveForm()) reset();
              }}
            >
              Начать другое объявление
            </button>
          )}
          {step > 0 && !locked && (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => {
                setError('');
                setStep(step - 1);
              }}
            >
              Назад
            </button>
          )}
          <button
            className="primary"
            disabled={
              busy ||
              !definitions ||
              disabled ||
              sessionExpired ||
              (!locked && needsAgencyChoice)
            }
            type="submit"
          >
            {busy
              ? 'Сохраняем…'
              : locked
                ? 'Повторить сохранение'
                : step < steps.length - 1
                  ? 'Далее'
                  : 'Перейти к фотографиям'}
          </button>
        </div>
      )}
      {completed && (
        <>
          <p role="status">
            Черновик сохранён. Добавьте фотографии и описание в редакторе
            объявления.
          </p>
          <button type="button" disabled={busy || disabled} onClick={reset}>
            Создать ещё объявление
          </button>
        </>
      )}
    </form>
  );
}
