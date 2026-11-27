import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import PlacementRulesPage from './page';
import SupportPage from '../page';

afterEach(cleanup);

test('readers can report a listing or appeal a decision from the public guide', () => {
  render(<PlacementRulesPage />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    'Правила размещения объявлений',
  );
  expect(
    screen
      .getByRole('link', { name: 'запросите пересмотр' })
      .getAttribute('href'),
  ).toBe('/support?write=1&topic=moderation');
  expect(
    screen
      .getByRole('link', { name: 'Пожаловаться на объявление' })
      .getAttribute('href'),
  ).toBe('/support?write=1&topic=complaint');
});

test.each([
  ['запросите пересмотр', 'moderation'],
  ['Пожаловаться на объявление', 'complaint'],
])(
  'opens the guest form for %s with its topic selected',
  async (name, topic) => {
    const guide = render(<PlacementRulesPage />);
    const link = screen.getByRole('link', { name }) as HTMLAnchorElement;
    const target = new URL(link.href);
    expect(target.pathname).toBe('/support');
    guide.unmount();
    render(
      await SupportPage({
        searchParams: Promise.resolve(Object.fromEntries(target.searchParams)),
      }),
    );
    const field = screen.getByRole('combobox', {
      name: 'Тема обращения',
    }) as HTMLSelectElement;
    expect(field.value).toBe(topic);
  },
);
