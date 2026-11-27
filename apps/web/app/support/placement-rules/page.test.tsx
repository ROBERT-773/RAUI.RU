import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import PlacementRulesPage from './page';

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
