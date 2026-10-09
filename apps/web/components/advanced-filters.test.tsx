import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import AdvancedFilters, { advancedDefinition } from './advanced-filters';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const floor = { code: 'floor', name: 'Этаж', kind: 'number', options: [] };
const elevator = {
  code: 'elevator',
  name: 'Лифт',
  kind: 'boolean',
  options: [],
};
function deferredLookups() {
  const replies: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: () =>
        new Promise((resolve, reject) => replies.push({ resolve, reject })),
    })),
  );
  return replies;
}
test('serialization preserves unrendered attributes and treats blank rendered endpoints as deliberate clears', () => {
  const data = new FormData();
  data.set('attribute:floor:min', '');
  data.set('attribute:floor:max', '8');
  data.set('attribute:elevator:boolean', '');
  expect(
    advancedDefinition(data, {
      floor: { min: 0, max: 8 },
      elevator: false,
      unseen: 'saved',
    }).attributes,
  ).toEqual({ floor: { max: 8 }, unseen: 'saved' });
});
test('advanced serialization leaves room and area clears to the basic range controls', () => {
  expect(
    advancedDefinition(new FormData(), {
      rooms: { min: 2, max: 4 },
      area: { max: 90 },
      unseen: 'saved',
    }).attributes,
  ).toEqual({ unseen: 'saved' });
});
test('pending lookup exposes status and failed lookup retries without losing saved zero/false values', async () => {
  const replies = deferredLookups();
  const { container } = render(
    <form>
      <AdvancedFilters
        category="apartment"
        definition={{
          category: 'apartment',
          attributes: { floor: { min: 0, max: 8 }, elevator: false },
        }}
      />
    </form>,
  );
  expect(screen.getByRole('status').textContent).toMatch(/Загрузка.*фильтр/);
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  await act(async () => replies[0]!.reject(new Error('unavailable')));
  expect(screen.getByRole('alert').textContent).toMatch(/Не удалось.*фильтр/);
  fireEvent.click(screen.getByRole('button', { name: /Повторить.*фильтр/ }));
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  await act(async () => replies[1]!.resolve([floor, elevator]));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByLabelText('От')).toHaveProperty('value', '0');
  expect(screen.getByLabelText('До')).toHaveProperty('value', '8');
  expect(screen.getByLabelText('Лифт')).toHaveProperty('value', 'false');
  expect(
    advancedDefinition(new FormData(container.querySelector('form')!))
      .attributes,
  ).toEqual({ floor: { min: 0, max: 8 }, elevator: false });
});
test('category change immediately removes old controls and ignores obsolete lookup success and failure', async () => {
  const replies = deferredLookups();
  const definition = {
    category: 'apartment',
    attributes: { elevator: false },
  };
  const view = render(
    <AdvancedFilters category="apartment" definition={definition} />,
  );
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  await act(async () => replies[0]!.resolve([elevator]));
  expect(screen.getByLabelText('Лифт')).toHaveProperty('value', 'false');
  fireEvent.change(screen.getByLabelText('Лифт'), {
    target: { value: 'true' },
  });
  view.rerender(<AdvancedFilters category="house" definition={definition} />);
  expect(screen.queryByLabelText('Лифт')).toBeNull();
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  view.rerender(<AdvancedFilters category="land" definition={definition} />);
  await vi.waitFor(() => expect(replies).toHaveLength(3));
  await act(async () => replies[2]!.resolve([floor]));
  await act(async () => replies[1]!.reject(new Error('obsolete')));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByLabelText('От')).toHaveProperty('value', '');
  view.rerender(<AdvancedFilters category="house" definition={definition} />);
  await vi.waitFor(() => expect(replies).toHaveLength(4));
  view.rerender(<AdvancedFilters category="land" definition={definition} />);
  await vi.waitFor(() => expect(replies).toHaveLength(5));
  expect(screen.queryByLabelText('От')).toBeNull();
  await act(async () => replies[3]!.resolve([elevator]));
  expect(screen.queryByLabelText('Лифт')).toBeNull();
  await act(async () => replies[4]!.resolve([elevator]));
  expect(screen.getByLabelText('Лифт')).toHaveProperty('value', '');
  expect(screen.getByText(/фильтры.*предыдущ.*категории/i)).toBeTruthy();
});
