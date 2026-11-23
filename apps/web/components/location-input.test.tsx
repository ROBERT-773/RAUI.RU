import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { api } from '../lib/client';
import LocationInput from './location-input';

vi.mock('../lib/client', () => ({ api: vi.fn() }));
afterEach(cleanup);

test('scopes metro options and their line names to the selected region', () => {
  const input = (region: string) => (
    <LocationInput kind="metro" name="metro" label="Метро" region={region} />
  );
  const { rerender } = render(input('moscow'));
  const search = screen.getByRole<HTMLInputElement>('textbox', {
    name: 'Метро',
  });
  fireEvent.focus(search);
  fireEvent.change(search, { target: { value: 'Арбатская' } });
  expect(screen.getAllByRole('button', { name: /Арбатская/ })).toHaveLength(2);
  rerender(input('saint_petersburg'));
  expect(search.value).toBe('');
  expect(screen.queryByRole('button', { name: /Арбатская/ })).toBeNull();
  fireEvent.change(search, { target: { value: 'Авто' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Автово · Кировско-Выборгская' }),
  );
  expect(search.value).toBe('Автово');
  expect(screen.queryByRole('list', { name: 'Станции метро' })).toBeNull();
  expect(api).not.toHaveBeenCalled();
});
