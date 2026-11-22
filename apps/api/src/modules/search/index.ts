import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { loadConfig } from '../../config';
export const listingMapping = {
  settings: {
    analysis: {
      filter: {
        raui_synonyms: { type: 'synonym', synonyms: ['квартира, апартаменты'] },
      },
      analyzer: {
        raui_text: {
          tokenizer: 'standard',
          filter: [
            'lowercase',
            'raui_synonyms',
            'russian_stop',
            'russian_stemmer',
          ],
        },
      },
      normalizer: { fold: { type: 'custom', filter: ['lowercase'] } },
    },
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      id: { type: 'keyword' },
      title: { type: 'text', analyzer: 'raui_text' },
      description: { type: 'text', analyzer: 'raui_text' },
      address: { type: 'text', analyzer: 'raui_text' },
      category: { type: 'keyword' },
      deal_type: { type: 'keyword' },
      region_code: { type: 'keyword' },
      locality: { type: 'keyword' },
      district: { type: 'keyword' },
      seller_type: { type: 'keyword' },
      source_type: { type: 'keyword' },
      price: { type: 'double' },
      price_per_m2: { type: 'double' },
      area: { type: 'double' },
      published_at: { type: 'date' },
      location: { type: 'geo_point' },
      attributes: {
        type: 'nested',
        properties: {
          code: { type: 'keyword' },
          number: { type: 'double' },
          keyword: { type: 'keyword' },
          boolean: { type: 'boolean' },
        },
      },
    },
  },
};
// Built-in Russian analyzer's components must be declared for custom analyzers.
Object.assign(listingMapping.settings.analysis.filter, {
  russian_stop: { type: 'stop', stopwords: '_russian_' },
  russian_stemmer: { type: 'stemmer', language: 'russian' },
});
@Injectable()
export class SearchIndex {
  readonly config = loadConfig();
  readonly alias = this.config.OPENSEARCH_ALIAS;
  async request(path: string, method = 'GET', body?: unknown) {
    try {
      const response = await fetch(this.config.OPENSEARCH_URL + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.OPENSEARCH_TOKEN
            ? { Authorization: 'Bearer ' + this.config.OPENSEARCH_TOKEN }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('search_status_' + response.status);
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ServiceUnavailableException('Search temporarily unavailable');
    }
  }
  async exists() {
    try {
      await this.request('/' + this.alias);
      return true;
    } catch {
      return false;
    }
  }
  async initialize() {
    if (await this.exists()) {
      // Expand existing strict mappings before workers emit the new field.
      await this.request('/' + this.alias + '/_mapping', 'PUT', {
        properties: { region_code: { type: 'keyword' } },
      });
      return;
    }
    const name = this.alias + '-v3-' + Date.now();
    await this.request('/' + name, 'PUT', listingMapping);
    await this.request('/_aliases', 'POST', {
      actions: [
        { add: { index: name, alias: this.alias, is_write_index: true } },
      ],
    });
  }
  async write(
    id: string,
    revision: string,
    document: unknown,
    target = this.alias,
  ) {
    // Tombstones preserve external versions and prevent an old retry resurrecting a removed document.
    const payload = document ?? {
      id,
      title: '',
      description: '',
      address: '',
      category: '__deleted',
    };
    const path =
      '/' +
      target +
      '/_doc/' +
      id +
      '?version_type=external_gte&version=' +
      revision +
      '&refresh=false';
    await this.request(path, 'PUT', payload);
  }
}
