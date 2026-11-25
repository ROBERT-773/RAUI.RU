'use client';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import ListingPublicationActions from './listing-publication-actions';
import ListingMediaGallery from './listing-media-gallery';
import ListingModerationActions from './listing-moderation-actions';
import ListingModerationHints from './listing-moderation-hints';
import ListingUploadControls from './listing-upload-controls';
import ListingUploadProgress, {
  type UploadProgress,
} from './listing-upload-progress';
import {
  api,
  ApiError,
  ListingContactSelectionChangedError,
} from '../lib/client';
import SavedListingPreview from './saved-listing-preview';
import ListingContacts from './listing-contacts';
import {
  getListingContactSettings,
  visiblePhones,
  type ListingContactSettings,
} from '../lib/contact-settings';
import ListingEditorStatus from './listing-editor-status';
import SavedListingsList from './saved-listings-list';
import CabinetListingFilters from './cabinet-listing-filters';
import {
  commercialLand,
  listingAreaError,
  listingAttributeName,
  listingAttributeFields,
} from '../lib/listing-attribute-fields';
import NewListing from './new-listing';
import type { ListingTerms } from './listing-terms';
import ListingOfferFields from './listing-offer-fields';
import ListingPropertyFields, {
  type PropertyField,
} from './listing-property-fields';
interface Listing {
  id: string;
  address?: string;
  area?: string | null;
  floor?: string | null;
  property_id?: string;
  organization_id?: string | null;
  title: string;
  price: string | null;
  description: string;
  status: string;
  version: number;
  deal_type: string;
  terms?: ListingTerms;
}
interface PropertyDetails {
  id: string;
  version: number;
  category_code: string;
  attributes: Record<string, unknown>;
  address?: { formatted: string };
}
async function propertyEditorData(id: string) {
  const details = await api<PropertyDetails>(`v1/properties/${id}`);
  const fields = await api<PropertyField[]>(
    `v1/categories/${details.category_code}/attributes`,
  );
  return { details, fields };
}
function missingRequiredFields(
  attributes: Record<string, unknown>,
  fields: PropertyField[],
) {
  return fields.filter(({ code, required }) => {
    const value = attributes[code];
    return (
      required &&
      (value == null || (typeof value === 'string' && value.trim() === ''))
    );
  });
}
interface PublicationQuota {
  applies: boolean;
  limit: number | null;
  publishedObjects: number | null;
  remaining: number | null;
}
interface Media {
  id: string;
  kind: string;
  state: string;
}
function mediaReadyForModeration(media: Media[]) {
  const count = media.filter(({ kind }) => kind === 'photo').length;
  return (
    count >= 5 && count <= 21 && media.every(({ state }) => state === 'ready')
  );
}
function offerValidationError(title: string, price: number) {
  if (title.trim().length < 3)
    return 'Введите заголовок длиной не менее трёх символов.';
  if (!Number.isFinite(price) || price <= 0) return 'Укажите цену больше нуля.';
}
interface History {
  event: string;
  after_data: { reason?: string };
}
const lastModerationReason = (history: History[]) =>
  history.filter(({ event }) => event === 'moderation.decided').at(-1)
    ?.after_data.reason ?? '';
const imageExtensions: Record<string, RegExp> = {
  'image/jpeg': /\.(jpg|jpeg)$/i,
  'image/png': /\.png$/i,
  'image/webp': /\.webp$/i,
};

const listingRepresentation = (item: Listing) =>
  item.organization_id ? 'От организации' : 'От своего имени';
function retainCreatedDraft(items: Listing[], draft?: Listing) {
  return draft && !items.some(({ id }) => id === draft.id)
    ? [draft, ...items]
    : items;
}
function tableProperty(property: PropertyDetails) {
  const { area, floor } = property.attributes;
  return {
    ...(property.address && { address: property.address.formatted }),
    area: area == null ? null : String(area),
    floor: floor == null ? null : String(floor),
  };
}
export default function OwnerListings({
  regions = [],
  initialAgencyId = '',
}: {
  regions?: { code: string; name: string }[];
  initialAgencyId?: string;
} = {}) {
  const [allowed, setAllowed] = useState(false),
    [checking, setChecking] = useState(true);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [items, setItems] = useState<Listing[]>([]),
    [more, setMore] = useState(false);
  const [listLoadFailed, setListLoadFailed] = useState(false);
  const [listFilters, setListFilters] = useState('');
  const listCursor = useRef('');
  const [editingPublication, setEditingPublication] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null),
    [media, setMedia] = useState<Media[]>([]),
    [reason, setReason] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [contacts, setContacts] = useState<ListingContactSettings | null>(null);
  const openFromProfile = useEffectEvent((id: string, edit: boolean) => {
    void open(id, edit);
  });
  const explicitOpen = useRef<string | null>(null);
  const [editOnOpen, setEditOnOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!allowed) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('listing');
    if (id && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) {
      explicitOpen.current = id;
      openFromProfile(id, params.get('edit') === '1');
    }
  }, [allowed]);
  const formId = useId();
  const savedHeading = useRef<HTMLHeadingElement>(null);
  const focusSavedList = useRef(false);
  useEffect(() => {
    if (!listing && focusSavedList.current) {
      savedHeading.current?.focus();
      focusSavedList.current = false;
    }
  }, [listing]);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const restoreEditorFocus = useRef(false);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (previewOpen) {
      restoreEditorFocus.current = true;
      previewHeading.current?.focus();
    } else if (restoreEditorFocus.current) {
      restoreEditorFocus.current = false;
      editorHeading.current?.focus();
    }
  }, [previewOpen]);
  const createdDraftToFocus = useRef<string | null>(null);
  const [draftToReopen, setDraftToReopen] = useState<string | null>(null);
  const [property, setProperty] = useState<PropertyDetails | null>(null);
  const [propertyFields, setPropertyFields] = useState<PropertyField[]>([]);
  const [commercialType, setCommercialType] = useState<unknown>();
  const [propertyDirty, setPropertyDirty] = useState(false);
  const [mediaRefreshNeeded, setMediaRefreshNeeded] = useState(false);
  const [title, setTitle] = useState(''),
    [price, setPrice] = useState(''),
    [description, setDescription] = useState('');
  const [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [terms, setTerms] = useState<ListingTerms>({});
  const [owner, setOwner] = useState(false);
  const [sellerRole, setSellerRole] = useState('');
  const showRepresentation = ['agent', 'agency', 'developer'].includes(
    sellerRole,
  );
  const [quota, setQuota] = useState<PublicationQuota | null>(null);
  const [quotaError, setQuotaError] = useState(false);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const quotaGeneration = useRef(0);
  const identityGeneration = useRef(0);
  const requireSignIn = useCallback(() => {
    quotaGeneration.current++;
    setAllowed(false);
    setNeedsSignIn(true);
    setOwner(false);
    setSellerRole('');
  }, []);
  const [creating, setCreating] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  );
  const uploadPending = uploadProgress !== null;
  const epoch = useRef(0),
    mounted = useRef(true),
    acting = useRef(false);
  const transitionKeys = useRef(new Map<string, string>());
  const upload = useRef<
    {
      listingId: string;
      kind: 'photo' | 'floor_plan';
      file: File;
      key: string;
      base64?: string;
    }[]
  >([]);
  const refreshQuota = useCallback(async () => {
    const request = ++quotaGeneration.current;
    const identity = identityGeneration.current;
    setQuotaLoading(true);
    setQuotaError(false);
    setQuota(null);
    try {
      const value = await api<PublicationQuota>('v1/account/publication-quota');
      if (
        !mounted.current ||
        request !== quotaGeneration.current ||
        identity !== identityGeneration.current
      )
        return;
      setQuota(value);
    } catch (e) {
      if (
        !mounted.current ||
        request !== quotaGeneration.current ||
        identity !== identityGeneration.current
      )
        return;
      if (e instanceof Error && 'status' in e && e.status === 401) {
        requireSignIn();
        setError(e.message);
      } else setQuotaError(true);
    } finally {
      if (
        mounted.current &&
        request === quotaGeneration.current &&
        identity === identityGeneration.current
      )
        setQuotaLoading(false);
    }
  }, [requireSignIn]);
  useEffect(() => {
    mounted.current = true;
    const identity = ++identityGeneration.current;
    void (async () => {
      try {
        const user = await api<{
          role: string;
          email_verified_at: string | null;
          phone_verified_at: string | null;
          registration_approval_state?: string;
        }>('v1/auth/me');
        if (!mounted.current || identity !== identityGeneration.current) return;
        setSellerRole(user.role);
        const canSell = [
          'owner',
          'agent',
          'agency',
          'developer',
          'admin',
        ].includes(user.role);
        const eligible =
          (!user.registration_approval_state ||
            user.registration_approval_state === 'approved') &&
          canSell &&
          Boolean(user.email_verified_at && user.phone_verified_at);
        setAllowed(eligible);
        if (!eligible) {
          setError(
            !canSell
              ? 'Размещение доступно в кабинете продавца.'
              : user.registration_approval_state === 'pending'
                ? 'Дождитесь одобрения регистрации сотрудником.'
                : user.registration_approval_state === 'rejected'
                  ? 'Регистрация отклонена. Причина указана в вашем аккаунте.'
                  : 'Подтвердите email и телефон, чтобы размещать объявления.',
          );
          return;
        }
        setOwner(user.role === 'owner');
        if (user.role === 'owner') void refreshQuota();
        try {
          const value = await api<Listing[]>('v1/listings?limit=20');
          if (mounted.current && identity === identityGeneration.current) {
            setItems(value);
            listCursor.current = value.at(-1)?.id ?? '';
            setMore(value.length === 20);
          }
        } catch (failure) {
          if (failure instanceof ApiError && failure.status === 401)
            throw failure;
          if (mounted.current && identity === identityGeneration.current)
            setListLoadFailed(true);
        }
      } catch (e) {
        if (mounted.current && identity === identityGeneration.current) {
          if (e instanceof ApiError && e.status === 401) requireSignIn();
          setError(
            e instanceof Error ? e.message : 'Не удалось загрузить объявления.',
          );
        }
      } finally {
        if (mounted.current && identity === identityGeneration.current)
          setChecking(false);
      }
    })();
    const requests = epoch,
      identities = identityGeneration,
      quotaRequests = quotaGeneration;
    return () => {
      mounted.current = false;
      identities.current++;
      quotaRequests.current++;
      requests.current++;
    };
  }, [refreshQuota, requireSignIn]);
  const assign = useCallback((value: Listing) => {
    if (!mounted.current) return;
    setListing(value);
    setTitle(value.title);
    setPrice(value.price ?? '');
    setDescription(value.description);
    setTerms(value.terms ?? {});
    setItems((current) =>
      current.map((item) =>
        item.id === value.id ? { ...item, ...value } : item,
      ),
    );
  }, []);
  async function open(id: string, edit = false) {
    const request = ++epoch.current;
    setEditingPublication(false);
    setPreviewOpen(false);
    setLoading(true);
    setListing(null);
    setContacts(null);
    setProperty(null);
    setPropertyDirty(false);
    setPropertyFields([]);
    setMedia([]);
    setMediaRefreshNeeded(false);
    setReason('');
    setError('');
    setNotice('');
    upload.current = [];
    setUploadProgress(null);
    try {
      const [value, photos, history, contactSettings] = await Promise.all([
        api<Listing>(`v1/listings/${id}`),
        api<Media[]>(`v1/media/listing/${id}`),
        api<History[]>(`v1/listings/${id}/history`).catch(() => null),
        getListingContactSettings(id).catch(() => null),
      ]);
      if (request !== epoch.current || !mounted.current) return;
      setEditOnOpen(edit ? id : null);
      setDraftToReopen((current) => (current === id ? null : current));
      assign(value);
      setContacts(contactSettings);
      if (createdDraftToFocus.current === id)
        setItems((current) => retainCreatedDraft(current, value));
      setMedia(photos);
      setReason(history ? lastModerationReason(history) : '');
      if (!history)
        setError(
          'История объявления недоступна. Попробуйте открыть его повторно.',
        );
      if (value.property_id) {
        try {
          const { details, fields } = await propertyEditorData(
            value.property_id,
          );
          if (request === epoch.current && mounted.current) {
            setProperty(details);
            setItems((current) =>
              current.map((item) =>
                item.id === id ? { ...item, ...tableProperty(details) } : item,
              ),
            );
            setCommercialType(details.attributes.commercial_property_type);
            setPropertyFields(fields);
          }
        } catch {
          if (request === epoch.current && mounted.current)
            setNotice(
              'Не удалось загрузить характеристики объекта. Откройте объявление повторно.',
            );
        }
      }
      return value;
    } catch (failure) {
      if (request === epoch.current && mounted.current) {
        if (failure instanceof ApiError && failure.status === 401) {
          requireSignIn();
          setError(failure.message);
          return;
        }
        if (createdDraftToFocus.current === id) {
          setDraftToReopen(id);
          setError('Черновик сохранён, но редактор не открылся.');
          return;
        }
        setError(
          'Не удалось открыть объявление. Обновите список и попробуйте ещё раз.',
        );
      }
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }
  const refresh = useCallback(async (id: string) => {
    const [value, photos] = await Promise.all([
      api<Listing>(`v1/listings/${id}`),
      api<Media[]>(`v1/media/listing/${id}`),
    ]);
    return { value, photos };
  }, []);
  async function run(action: () => Promise<void>, savingEdits = false) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      if (mounted.current) {
        if (e instanceof ApiError && e.status === 401) requireSignIn();
        setError(
          savingEdits && e instanceof ApiError && e.status === 409
            ? 'Объявление изменилось. Скопируйте нужные правки, отмените несохранённые изменения и откройте объявление заново.'
            : e instanceof Error
              ? e.message
              : 'Не удалось выполнить действие.',
        );
      }
    } finally {
      acting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function loadMore() {
    await run(async () => {
      const value = await api<Listing[]>(
        `v1/listings?limit=20&after=${listCursor.current}${listFilters ? '&' + listFilters : ''}`,
      );
      if (mounted.current) {
        listCursor.current = value.at(-1)?.id ?? '';
        setItems((current) => [
          ...current,
          ...value.filter((item) => !current.some((old) => old.id === item.id)),
        ]);
        setMore(value.length === 20);
      }
    });
  }
  async function searchListings(filters: string) {
    const value = await api<Listing[]>(
      'v1/listings?limit=20' + (filters ? '&' + filters : ''),
    );
    if (!mounted.current) return;
    setListFilters(filters);
    listCursor.current = value.at(-1)?.id ?? '';
    setItems(value);
    setMore(value.length === 20);
    setListLoadFailed(false);
  }
  function key(value: Listing, status: string) {
    const id = `${value.id}:${value.version}:${status}`;
    if (!transitionKeys.current.has(id))
      transitionKeys.current.set(id, crypto.randomUUID());
    return transitionKeys.current.get(id)!;
  }
  async function transition(value: Listing, status: string) {
    const updated = await api<Listing>(
      `v1/listings/${value.id}/transitions`,
      'POST',
      { version: value.version, status },
      { idempotencyKey: key(value, status) },
    );
    if (
      mounted.current &&
      owner &&
      value.status === 'published' &&
      updated.status !== 'published'
    )
      await refreshQuota();
    return updated;
  }
  async function reviewListing(action: 'preview' | 'submit') {
    if (!listing || (action === 'submit' && !previewOpen)) return;
    const request = epoch.current;
    const [{ value, photos }, currentContacts] = await Promise.all([
      refresh(listing.id),
      getListingContactSettings(listing.id),
    ]);
    const data = value.property_id
      ? await propertyEditorData(value.property_id)
      : null;
    if (!mounted.current || request !== epoch.current) return;
    setContacts(currentContacts);
    assign(value);
    setMedia(photos);
    setProperty(data?.details ?? null);
    setPropertyFields(data?.fields ?? []);
    setCommercialType(data?.details.attributes.commercial_property_type);

    if (value.status === 'moderation') {
      setPreviewOpen(false);
      setNotice(
        'Объявление отправлено на модерацию. Оно появится после одобрения.',
      );
      return;
    }
    let invalid: string | undefined;
    if (!['draft', 'paused', 'rejected', 'processing'].includes(value.status))
      invalid = 'Статус объявления изменился. Проверьте его перед отправкой.';
    else if (!mediaReadyForModeration(photos))
      invalid =
        'Список фотографий изменился. Проверьте фотографии перед отправкой.';
    else if (value.description.trim().length < 15)
      invalid =
        'Описание изменилось. Сохраните описание длиной не менее 15 символов перед отправкой.';
    else if (
      data &&
      missingRequiredFields(data.details.attributes, data.fields).length
    )
      invalid =
        'Проверьте обязательные характеристики объекта перед отправкой.';
    else invalid = offerValidationError(value.title, Number(value.price));
    if (invalid) {
      setPreviewOpen(false);
      throw new Error(invalid);
    }
    if (action === 'preview') {
      setPreviewOpen(true);
      return;
    }
    if (
      currentContacts.canEdit &&
      currentContacts.mode !== 'messages' &&
      !visiblePhones(currentContacts).length
    ) {
      setPreviewOpen(false);
      throw new Error(
        'Выберите подтверждённый телефон в контактах объявления или включите только сообщения в профиле.',
      );
    }
    const recoveredProcessing =
      value.status === 'processing' &&
      value.version === listing.version + 1 &&
      transitionKeys.current.has(`${listing.id}:${listing.version}:processing`);
    if (
      value.id !== listing.id ||
      !contacts ||
      contacts.mode !== currentContacts.mode ||
      JSON.stringify(visiblePhones(contacts).map((p) => p.phone)) !==
        JSON.stringify(visiblePhones(currentContacts).map((p) => p.phone)) ||
      (value.version !== listing.version && !recoveredProcessing) ||
      data?.details.id !== property?.id ||
      data?.details.version !== property?.version ||
      photos.length !== media.length ||
      photos.some(
        (item, index) =>
          item.id !== media[index]?.id || item.kind !== media[index]?.kind,
      )
    ) {
      setPreviewOpen(false);
      throw new Error(
        'Объявление изменилось. Откройте предпросмотр ещё раз и проверьте обновлённые данные.',
      );
    }
    let current = value;
    if (current.status !== 'processing') {
      current = await transition(current, 'processing');
      if (!mounted.current) return;
      assign(current);
    }
    if (!['processing', 'moderation'].includes(current.status)) {
      setPreviewOpen(false);
      throw new Error(
        'Статус объявления изменился. Проверьте его перед отправкой.',
      );
    }
    const submitted =
      current.status === 'moderation'
        ? current
        : await transition(current, 'moderation');
    if (!mounted.current) return;
    assign(submitted);
    setPreviewOpen(false);
    if (submitted.status !== 'moderation')
      throw new Error(
        'Статус объявления изменился. Проверьте его перед отправкой.',
      );
    setNotice(
      'Объявление отправлено на модерацию. Оно появится после одобрения.',
    );
  }
  function closeSavedDraft(value: Listing) {
    if (!mounted.current) return;
    if (value.status !== 'draft')
      throw new Error(
        'Статус объявления изменился. Откройте его снова в кабинете.',
      );
    setItems((current) => [
      { ...current.find((item) => item.id === value.id), ...value },
      ...current.filter((item) => item.id !== value.id),
    ]);
    setPropertyDirty(false);
    setDraftToReopen(null);
    setPreviewOpen(false);
    focusSavedList.current = true;
    setListing(null);
    setNotice(
      'Черновик сохранён. Продолжить заполнение можно в списке «Сохранённые объявления».',
    );
  }
  async function keepDraft() {
    if (!listing) return;
    const current = await api<Listing>(`v1/listings/${listing.id}`);
    if (!mounted.current) return;
    if (current.status === 'draft') {
      closeSavedDraft(current);
    } else if (
      current.version !== listing.version ||
      current.status !== listing.status
    ) {
      throw new Error(
        'Статус объявления изменился. Откройте его снова в кабинете.',
      );
    } else if (current.status === 'paused') {
      closeSavedDraft(
        await api<Listing>(`v1/listings/${current.id}`, 'PATCH', {
          version: current.version,
        }),
      );
    } else if (['rejected', 'processing'].includes(current.status)) {
      closeSavedDraft(await transition(current, 'draft'));
    } else {
      throw new Error(
        'Статус объявления изменился. Откройте его снова в кабинете.',
      );
    }
  }
  const editable =
    listing && ['draft', 'paused', 'rejected'].includes(listing.status);
  const termsChanged =
    JSON.stringify(terms) !== JSON.stringify(listing?.terms ?? {});
  const dirty =
    listing &&
    (title !== listing.title ||
      price !== (listing.price ?? '') ||
      description !== listing.description ||
      termsChanged);
  const hasUnsavedChanges = Boolean(dirty) || propertyDirty;
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnAboutUnsavedChanges = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', warnAboutUnsavedChanges);
    return () =>
      window.removeEventListener('beforeunload', warnAboutUnsavedChanges);
  }, [hasUnsavedChanges]);
  const readyPhotos = media.filter(
    (item) => item.kind === 'photo' && item.state === 'ready',
  ).length;
  const photoCount = media.filter((item) => item.kind === 'photo').length;
  const processingImages = media.some((item) =>
    ['queued', 'pending', 'processing'].includes(item.state),
  );
  const listingId = listing?.id;
  const applied = new URLSearchParams(listFilters);
  const currentStatus = applied.get('status');
  const currentDeal = applied.get('deal');
  const currentQuery = applied.get('q')?.toLocaleLowerCase('ru');
  const visibleItems = items.filter(
    (item) =>
      (!currentStatus || item.status === currentStatus) &&
      (!currentDeal ||
        (currentDeal === 'sale'
          ? item.deal_type === 'sale'
          : item.deal_type === 'long_rent' ||
            item.deal_type === 'short_rent')) &&
      (!currentQuery ||
        item.id.toLowerCase() === currentQuery ||
        item.title.toLocaleLowerCase('ru').includes(currentQuery) ||
        item.address?.toLocaleLowerCase('ru').includes(currentQuery)),
  );
  useEffect(() => {
    if (
      !loading &&
      listingId &&
      (createdDraftToFocus.current === listingId ||
        explicitOpen.current === listingId)
    ) {
      createdDraftToFocus.current = null;
      explicitOpen.current = null;
      editorHeading.current?.focus();
    }
  }, [listingId, loading]);
  useEffect(() => {
    if (
      !allowed ||
      !listingId ||
      (!processingImages && !mediaRefreshNeeded) ||
      busy ||
      creating
    )
      return;
    let active = true;
    let checkingImages = false;
    const timer = window.setInterval(async () => {
      if (checkingImages || acting.current) return;
      checkingImages = true;
      try {
        const updated = mediaRefreshNeeded ? await refresh(listingId) : null;
        const images =
          updated?.photos ??
          (await api<Media[]>(`v1/media/listing/${listingId}`));
        if (active && !acting.current) {
          if (updated) assign(updated.value);
          setMedia(images);
          setMediaRefreshNeeded(false);
        }
      } catch (failure) {
        if (
          active &&
          !acting.current &&
          failure instanceof ApiError &&
          failure.status === 401
        ) {
          window.clearInterval(timer);
          requireSignIn();
          setError(failure.message);
        }
      } finally {
        checkingImages = false;
      }
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [
    allowed,
    listingId,
    processingImages,
    mediaRefreshNeeded,
    busy,
    creating,
    assign,
    refresh,
    requireSignIn,
  ]);
  const isCommercialLand =
    property?.category_code === 'commercial' &&
    commercialType === commercialLand;
  const missingFields = property
    ? missingRequiredFields(property.attributes, propertyFields)
    : [];
  const ready = !mediaRefreshNeeded && mediaReadyForModeration(media);
  const savedOfferError = listing
    ? offerValidationError(listing.title, Number(listing.price))
    : undefined;
  return (
    <section>
      <h1>Мои объявления</h1>
      {needsSignIn ? (
        <Link href="/account?action=publish">Войти или зарегистрироваться</Link>
      ) : (
        <Link
          href="/account"
          onClick={(event) => {
            if (
              hasUnsavedChanges &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              !window.confirm(
                'В объявлении есть несохранённые правки. Выйти без сохранения?',
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          Вернуться в аккаунт
        </Link>
      )}
      {!checking && !allowed && !needsSignIn && (
        <p>
          {sellerRole === 'buyer' ? (
            <Link href="/search">Перейти в каталог</Link>
          ) : (
            <Link href="/account">Профиль и подтверждение контактов</Link>
          )}
        </p>
      )}
      {checking && <p>Проверяем доступ…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {allowed && (
        <div hidden={previewOpen}>
          {owner && quota?.applies !== false && (
            <section className="panel" aria-label="Лимит публикации объектов">
              <h2>Лимит публикации объектов</h2>
              {quotaLoading && <p role="status">Загружаем лимит публикации…</p>}
              {quota?.applies && (
                <p>
                  Активных объявлений: {quota.publishedObjects} из {quota.limit}
                  . Свободных мест: {quota.remaining}.
                </p>
              )}
              {quota?.applies && quota.publishedObjects! >= quota.limit! && (
                <p>
                  Лимит новых объектов достигнут. Уже опубликованные объявления
                  сохраняются.
                </p>
              )}
              {quotaError && (
                <p role="alert">
                  Не удалось загрузить лимит публикации. Обновите данные.
                </p>
              )}
              <p>
                Разрешено одно активное объявление и три публикации в
                календарный месяц. Чтобы освободить место, приостановите
                действующее объявление.
              </p>
              <p>
                Приостановка не уменьшает число публикаций за месяц. Повторная
                публикация тоже учитывается в лимите. Календарный месяц
                считается по московскому времени.
              </p>
              <p>
                Если одобрение не прошло из-за лимита, заявка остаётся на
                модерации. После освобождения места сотрудник может повторить
                одобрение той же заявки. Отправлять её заново не нужно.
              </p>
              <p>
                Создавать и редактировать черновики, добавлять фотографии и
                отправлять объявления на модерацию можно и при достигнутом
                лимите.
              </p>
              <button
                type="button"
                disabled={quotaLoading}
                onClick={() => void refreshQuota()}
              >
                Обновить лимит публикации
              </button>
            </section>
          )}
          <NewListing
            regions={regions}
            sellerRole={sellerRole}
            initialAgencyId={initialAgencyId}
            onBusyChange={(value) => {
              if (mounted.current) setCreating(value);
            }}
            disabled={busy || loading || hasUnsavedChanges}
            onCreated={(id) =>
              void run(async () => {
                createdDraftToFocus.current = id;
                const draft = await open(id);
                if (!mounted.current) return;
                try {
                  const value = await api<Listing[]>('v1/listings?limit=20');
                  if (!mounted.current) return;
                  setItems(retainCreatedDraft(value, draft));
                  setListFilters('');
                  listCursor.current = value.at(-1)?.id ?? '';
                  setMore(value.length === 20);
                  setListLoadFailed(false);
                } catch {
                  if (mounted.current)
                    setNotice(
                      'Черновик сохранён. Обновите страницу, чтобы обновить список объявлений.',
                    );
                }
              })
            }
          />
          {draftToReopen && (
            <button
              type="button"
              disabled={busy || creating || loading || hasUnsavedChanges}
              onClick={() => {
                createdDraftToFocus.current = draftToReopen;
                void open(draftToReopen);
              }}
            >
              Открыть сохранённый черновик
            </button>
          )}
          <CabinetListingFilters
            key={listFilters}
            filters={listFilters}
            disabled={
              busy || creating || checking || loading || hasUnsavedChanges
            }
            onSearch={(filters) => void run(() => searchListings(filters))}
          />
          <SavedListingsList
            filtered={Boolean(listFilters)}
            headingRef={savedHeading}
            items={visibleItems.map((item) => ({
              ...item,
              representation: showRepresentation
                ? listingRepresentation(item)
                : undefined,
            }))}
            loadFailed={listLoadFailed}
            checking={checking}
            more={more}
            retryDisabled={busy || creating || loading}
            openDisabled={busy || creating || loading || hasUnsavedChanges}
            loadMoreDisabled={busy || creating}
            onRetry={() => void run(() => searchListings(listFilters))}
            onOpen={(id) => {
              explicitOpen.current = id;
              void open(id);
            }}
            onLoadMore={() => void loadMore()}
          />
          {loading && <p role="status">Загружаем объявление…</p>}
          {listing && (
            <article className="panel" id="listing-editor">
              <h2 ref={editorHeading} tabIndex={-1}>
                {listing.title || 'Черновик объявления'}
              </h2>
              {property?.address?.formatted && (
                <>
                  <p>Адрес объекта: {property.address.formatted}</p>
                  {editable && (
                    <p>Адрес сохранённого объявления изменить нельзя.</p>
                  )}
                </>
              )}
              <ListingEditorStatus
                status={listing.status}
                representation={
                  showRepresentation ? listingRepresentation(listing) : ''
                }
                rejectionReason={reason}
              />
              <ListingPublicationActions
                key={listing.id}
                initialEdit={editOnOpen === listing.id}
                listingId={listing.id}
                status={listing.status}
                disabled={busy || creating}
                hasUnsavedChanges={hasUnsavedChanges}
                onPause={() =>
                  void run(async () => {
                    assign(await transition(listing, 'paused'));
                    if (mounted.current) {
                      setEditingPublication(true);
                      setNotice('Размещение приостановлено.');
                    }
                  })
                }
                onArchive={() => {
                  if (
                    !window.confirm(
                      'Перенести объявление в архив? Оно исчезнет из каталога.',
                    )
                  )
                    return;
                  void run(async () => {
                    assign(await transition(listing, 'archived'));
                    if (mounted.current)
                      setNotice('Объявление перенесено в архив.');
                  });
                }}
              />
              {(listing.status === 'published' || editingPublication) && (
                <SavedListingPreview
                  listing={listing}
                  property={property}
                  propertyFields={propertyFields}
                  media={media}
                  contacts={contacts}
                />
              )}
              {editable && property && propertyFields.length > 0 && (
                <form
                  key={property.version}
                  id={formId + '-property'}
                  onChange={() => setPropertyDirty(true)}
                  onReset={() => {
                    setCommercialType(
                      property.attributes.commercial_property_type,
                    );
                    setPropertyDirty(false);
                  }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const closeAfterSave =
                      (
                        event.nativeEvent as SubmitEvent
                      ).submitter?.getAttribute('value') === 'save-draft';
                    const fields = new FormData(event.currentTarget);
                    const attributes = { ...property.attributes };
                    const visibleFields = listingAttributeFields(
                      property.category_code,
                      propertyFields,
                      commercialType,
                    );
                    for (const field of visibleFields) {
                      const value = String(fields.get(field.code) ?? '').trim();
                      if (!value) {
                        delete attributes[field.code];
                      } else {
                        attributes[field.code] =
                          field.kind === 'number'
                            ? Number(value)
                            : field.kind === 'boolean'
                              ? value === 'true'
                              : value;
                      }
                    }
                    const missingField = missingRequiredFields(
                      attributes,
                      visibleFields,
                    )[0];
                    if (missingField) {
                      setError(
                        `Заполните: ${listingAttributeName(missingField, isCommercialLand)}`,
                      );
                      return;
                    }
                    const areaError = listingAreaError(
                      visibleFields,
                      attributes,
                      isCommercialLand,
                    );
                    if (areaError) {
                      setError(areaError);
                      return;
                    }
                    const {
                      area,
                      kitchen_area: kitchen,
                      floor,
                      floors,
                    } = attributes;
                    if (
                      visibleFields.some(
                        ({ code }) => code === 'kitchen_area',
                      ) &&
                      typeof kitchen === 'number' &&
                      (kitchen < 0 ||
                        (typeof area === 'number' && kitchen > area))
                    ) {
                      setError(
                        'Площадь кухни должна быть от нуля до общей площади объекта.',
                      );
                      return;
                    }
                    if (
                      visibleFields.some(({ code }) => code === 'floor') &&
                      visibleFields.some(({ code }) => code === 'floors') &&
                      typeof floor === 'number' &&
                      typeof floors === 'number' &&
                      floor > floors
                    ) {
                      setError(
                        'Этаж не может быть больше количества этажей в доме.',
                      );
                      return;
                    }
                    void run(async () => {
                      const updated = await api<PropertyDetails>(
                        `v1/properties/${property.id}`,
                        'PATCH',
                        {
                          version: property.version,
                          attributes,
                        },
                      );
                      if (!mounted.current) return;
                      setProperty({ ...property, ...updated });
                      setPropertyDirty(false);
                      setCommercialType(
                        updated.attributes.commercial_property_type,
                      );
                      const current = await api<Listing>(
                        `v1/listings/${listing.id}`,
                      );
                      if (!mounted.current) return;
                      const revised = {
                        ...current,
                        ...tableProperty({ ...property, ...updated }),
                      };
                      assign(revised);
                      if (closeAfterSave) closeSavedDraft(revised);
                      else setNotice('Характеристики сохранены.');
                    }, true);
                  }}
                >
                  <ListingPropertyFields
                    category={property.category_code}
                    attributes={property.attributes}
                    propertyFields={propertyFields}
                    commercialType={commercialType}
                    dirty={propertyDirty}
                    disabled={
                      busy ||
                      creating ||
                      Boolean(dirty) ||
                      uploadPending ||
                      mediaRefreshNeeded
                    }
                    onCommercialTypeChange={setCommercialType}
                  />
                </form>
              )}
              <ListingMediaGallery
                media={media}
                photoCount={photoCount}
                refreshNeeded={mediaRefreshNeeded}
                editable={Boolean(editable)}
                removalDisabled={
                  busy ||
                  creating ||
                  hasUnsavedChanges ||
                  uploadPending ||
                  mediaRefreshNeeded
                }
                onRemove={(item) =>
                  void run(async () => {
                    await api(`v1/media/${item.id}`, 'DELETE');
                    if (!mounted.current) return;
                    setMedia((items) =>
                      items.filter(({ id }) => id !== item.id),
                    );
                    const result = await refresh(listing.id).catch(() => null);
                    if (!mounted.current) return;
                    if (!result) {
                      setMediaRefreshNeeded(true);
                      return;
                    }
                    assign(result.value);
                    setMedia(result.photos);
                    setNotice(
                      item.kind === 'floor_plan'
                        ? 'Планировка удалена. Можно загрузить замену.'
                        : 'Фотография удалена. Можно загрузить замену.',
                    );
                  })
                }
              />
              {editable && (
                <ListingUploadControls
                  blocked={
                    busy ||
                    creating ||
                    hasUnsavedChanges ||
                    uploadPending ||
                    mediaRefreshNeeded
                  }
                  photoCount={photoCount}
                  onFiles={(kind, files) =>
                    queueImages(listing.id, kind, files)
                  }
                />
              )}
              {uploadPending && editable && (
                <ListingUploadProgress
                  progress={uploadProgress}
                  busy={busy}
                  disabled={busy || creating || hasUnsavedChanges}
                  onRetry={() => void run(sendPhoto)}
                  onCancel={() =>
                    void run(async () => {
                      upload.current = [];
                      setUploadProgress(null);
                      setNotice('Оставшаяся загрузка отменена.');
                      const result = await refresh(listing.id).catch(
                        () => null,
                      );
                      if (!mounted.current) return;
                      setMediaRefreshNeeded(!result);
                      if (!result) return;
                      assign(result.value);
                      setMedia(result.photos);
                    })
                  }
                />
              )}
              <button
                disabled={busy || creating || hasUnsavedChanges}
                onClick={() =>
                  void run(async () => {
                    const result = await refresh(listing.id);
                    if (owner && mounted.current) await refreshQuota();
                    assign(result.value);
                    if (!mounted.current) return;
                    setMedia(result.photos);
                    setMediaRefreshNeeded(false);
                    if (result.value.status === 'rejected') {
                      setReason('');
                      try {
                        const history = await api<History[]>(
                          `v1/listings/${listing.id}/history`,
                        );
                        if (!mounted.current) return;
                        setReason(lastModerationReason(history));
                      } catch (failure) {
                        if (
                          failure instanceof ApiError &&
                          failure.status === 401
                        )
                          throw failure;
                        if (mounted.current)
                          setNotice(
                            'Статус обновлён. Причину отклонения загрузить не удалось. Нажмите «Обновить состояние» ещё раз.',
                          );
                        return;
                      }
                    }
                    setNotice('Состояние обновлено.');
                  })
                }
              >
                Обновить состояние
              </button>
              {editable && (
                <form
                  id={formId + '-offer'}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const closeAfterSave =
                      (
                        event.nativeEvent as SubmitEvent
                      ).submitter?.getAttribute('value') === 'save-draft';
                    const listingTitle = title.trim();
                    const listingPrice = Number(price);
                    const offerError = offerValidationError(
                      listingTitle,
                      listingPrice,
                    );
                    if (offerError) {
                      setError(offerError);
                      return;
                    }
                    void run(async () => {
                      const updated = await api<Listing>(
                        `v1/listings/${listing.id}`,
                        'PATCH',
                        {
                          version: listing.version,
                          title: listingTitle,
                          price: listingPrice,
                          description,
                          ...(termsChanged ? { terms } : {}),
                        },
                      );
                      assign(updated);
                      if (closeAfterSave) closeSavedDraft(updated);
                      else if (mounted.current)
                        setNotice('Изменения сохранены.');
                    }, true);
                  }}
                >
                  <ListingOfferFields
                    deal={listing.deal_type}
                    title={title}
                    price={price}
                    description={description}
                    terms={terms}
                    dirty={Boolean(dirty)}
                    disabled={
                      busy || creating || propertyDirty || mediaRefreshNeeded
                    }
                    onTitleChange={setTitle}
                    onPriceChange={setPrice}
                    onDescriptionChange={setDescription}
                    onTermsChange={setTerms}
                    onReset={() => assign(listing)}
                  />
                </form>
              )}
              {editable && (
                <button
                  type={hasUnsavedChanges ? 'submit' : 'button'}
                  form={
                    hasUnsavedChanges
                      ? formId + (propertyDirty ? '-property' : '-offer')
                      : undefined
                  }
                  value="save-draft"
                  disabled={
                    busy ||
                    creating ||
                    loading ||
                    uploadPending ||
                    mediaRefreshNeeded
                  }
                  onClick={
                    hasUnsavedChanges ? undefined : () => void run(keepDraft)
                  }
                >
                  Сохранить и выйти
                </button>
              )}
              <ListingContacts
                settings={contacts}
                disabled={busy || creating || hasUnsavedChanges}
                onRetry={() =>
                  void run(async () => {
                    const request = epoch.current;
                    const value = await getListingContactSettings(listing.id);
                    if (mounted.current && request === epoch.current)
                      setContacts(value);
                  })
                }
                onSelect={(ids) =>
                  void run(async () => {
                    if (!contacts || contacts.canEdit === false) return;
                    const request = epoch.current;
                    let result: ListingContactSettings;
                    try {
                      result = await api<ListingContactSettings>(
                        `v1/listings/${listing.id}/contact-settings`,
                        'PUT',
                        {
                          phoneIds: ids,
                          expectedPhoneIds: contacts.selectedPhoneIds,
                        },
                      );
                    } catch (failure) {
                      if (!mounted.current || request !== epoch.current) return;
                      if (
                        failure instanceof ListingContactSelectionChangedError
                      ) {
                        const actual = await getListingContactSettings(
                          listing.id,
                        ).catch(() => null);
                        if (!mounted.current || request !== epoch.current)
                          return;
                        setContacts(actual);
                      }
                      throw failure;
                    }
                    if (!mounted.current || request !== epoch.current) return;
                    setContacts(result);
                    const updated = await api<Listing>(
                      `v1/listings/${listing.id}`,
                    );
                    if (mounted.current && request === epoch.current) {
                      assign(updated);
                      setNotice('Контакты объявления сохранены.');
                    }
                  })
                }
              />
              <ListingModerationActions
                status={listing.status}
                withdrawDisabled={busy || creating || loading}
                previewDisabled={
                  busy ||
                  creating ||
                  loading ||
                  uploadPending ||
                  !ready ||
                  Boolean(savedOfferError) ||
                  hasUnsavedChanges ||
                  listing.description.trim().length < 15 ||
                  missingFields.length > 0
                }
                onWithdraw={() =>
                  void run(async () => {
                    const { value: current, photos } = await refresh(
                      listing.id,
                    );
                    if (!mounted.current) return;
                    assign(current);
                    setMedia(photos);
                    if (current.status === 'draft') {
                      setNotice('Объявление уже в черновиках.');
                      return;
                    }
                    if (!['processing', 'moderation'].includes(current.status))
                      throw new Error('Статус объявления изменился.');
                    if (
                      current.status === 'moderation' &&
                      !window.confirm(
                        'Отозвать объявление с модерации и вернуть в черновик?',
                      )
                    )
                      return;
                    const draft = await transition(current, 'draft');
                    if (!mounted.current) return;
                    assign(draft);
                    setNotice('Объявление возвращено в черновик.');
                  })
                }
                onPreview={() => void run(() => reviewListing('preview'))}
              >
                <ListingModerationHints
                  photosReady={ready}
                  readyPhotos={readyPhotos}
                  hasUnsavedChanges={hasUnsavedChanges}
                  offerError={savedOfferError}
                  descriptionTooShort={listing.description.trim().length < 15}
                  missingFieldNames={missingFields.map((field) =>
                    listingAttributeName(field, isCommercialLand),
                  )}
                />
              </ListingModerationActions>
            </article>
          )}
        </div>
      )}
      {allowed && previewOpen && listing && (
        <article className="panel" aria-labelledby="listing-preview-title">
          <h2 id="listing-preview-title" tabIndex={-1} ref={previewHeading}>
            Предпросмотр объявления
          </h2>
          <SavedListingPreview
            contacts={contacts}
            listing={listing}
            property={property}
            propertyFields={propertyFields}
            media={media}
          />
          <p>
            После отправки модератор проверит объявление. Оно появится в
            каталоге после одобрения.
          </p>
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setPreviewOpen(false)}
            >
              Вернуться к редактированию
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(keepDraft)}
            >
              Сохранить в черновики
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void run(() => reviewListing('submit'))}
            >
              Отправить на модерацию
            </button>
          </div>
        </article>
      )}
    </section>
  );
  function queueImages(
    listingId: string,
    kind: 'photo' | 'floor_plan',
    files: File[],
  ) {
    if (!files.length) return;
    void run(async () => {
      if (kind === 'photo' && files.length > 21 - photoCount)
        throw new Error(`Можно добавить ещё ${21 - photoCount} фото.`);
      if (kind === 'floor_plan' && files.length > 1)
        throw new Error('Выберите один файл планировки.');
      if (
        files.some(
          (file) =>
            file.name.length > 200 ||
            !imageExtensions[file.type]?.test(file.name) ||
            file.size === 0 ||
            file.size > 10 * 1024 * 1024 ||
            !/^([^/\\]+)\.(jpg|jpeg|png|webp)$/i.test(file.name),
        )
      )
        throw new Error('Выберите JPEG, PNG или WebP размером до 10 МБ.');
      upload.current = files.map((file) => ({
        listingId,
        kind,
        file,
        key: crypto.randomUUID(),
      }));
      setUploadProgress({
        total: files.length,
        remaining: files.length,
        kind,
        filename: files[0]?.name,
      });
      await sendPhoto();
    });
  }
  async function sendPhoto() {
    const first = upload.current[0];
    if (!first) return;
    let sent = 0;
    let refreshFailed = false;
    try {
      for (
        let pending = upload.current[0];
        pending && mounted.current;
        pending = upload.current[0]
      ) {
        if (!pending.base64)
          pending.base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () =>
              reject(new Error('Не удалось прочитать файл.'));
            reader.onload = () => resolve(String(reader.result).split(',')[1]!);
            reader.readAsDataURL(pending.file);
          });
        await api(
          'v1/media',
          'POST',
          {
            listingId: pending.listingId,
            ...(pending.kind === 'floor_plan' ? { kind: pending.kind } : {}),
            filename: pending.file.name,
            mime: pending.file.type,
            base64: pending.base64,
          },
          { idempotencyKey: pending.key },
        );
        upload.current.shift();
        sent++;
        const remaining = upload.current.length;
        const filename = upload.current[0]?.file.name;
        if (mounted.current)
          setUploadProgress(
            (current) =>
              current && {
                ...current,
                remaining,
                filename,
              },
          );
      }
    } finally {
      if (mounted.current) {
        if (!upload.current.length) setUploadProgress(null);
        if (sent > 0) {
          const result = await refresh(first.listingId).catch(() => null);
          if (mounted.current && result) {
            assign(result.value);
            setMedia(result.photos);
          }
          refreshFailed = !result;
          if (mounted.current) setMediaRefreshNeeded(refreshFailed);
        }
      }
    }
    if (mounted.current && !upload.current.length && !refreshFailed) {
      setNotice(
        first.kind === 'floor_plan'
          ? 'Планировка загружена и ожидает обработки.'
          : sent === 1
            ? 'Фотография загружена и ожидает обработки.'
            : 'Фотографии загружены и ожидают обработки.',
      );
    }
  }
}
