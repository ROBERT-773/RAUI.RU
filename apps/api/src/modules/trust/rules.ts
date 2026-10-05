export interface RuleFinding {
  code: string;
  severity: 'review' | 'block';
  confidence: number;
}
export function evaluateRules(input: {
  title: string;
  description: string;
  price: number | null;
}): RuleFinding[] {
  const findings: RuleFinding[] = [];
  if (!input.price || !Number.isFinite(input.price) || input.price <= 0)
    findings.push({ code: 'invalid_price', severity: 'block', confidence: 1 });
  if (input.title.trim().length < 3)
    findings.push({ code: 'missing_title', severity: 'block', confidence: 1 });
  const text = (input.title + ' ' + input.description).toLocaleLowerCase('ru');
  if (
    /(?:предоплат|переведите|оплат).{0,80}(?:до\s+просмотр|before\s+viewing)/u.test(
      text,
    ) ||
    /advance payment.{0,50}before viewing/u.test(text)
  )
    findings.push({
      code: 'advance_payment_before_viewing',
      severity: 'review',
      confidence: 0.8,
    });
  if (
    /(?:паспорт|passport).{0,60}(?:https?:\/\/|телеграм|telegram)/u.test(text)
  )
    findings.push({
      code: 'external_identity_collection',
      severity: 'review',
      confidence: 0.7,
    });
  return findings;
}
