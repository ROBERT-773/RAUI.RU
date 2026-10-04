import { expect, test } from 'vitest';
import { Button } from './index';
test('button defaults to non-submit and preserves accessibility props', () => {
  const button = Button({
    children: 'Ready',
    'aria-label': 'Ready',
    disabled: true,
  });
  expect(button.props.type).toBe('button');
  expect(button.props.disabled).toBe(true);
  expect(button.props['aria-label']).toBe('Ready');
});
