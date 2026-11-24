import { BadRequestException } from '@nestjs/common';
import type { FeedProfile } from './feed-parser';

export class FeedLinkError extends BadRequestException {
  constructor(
    readonly code:
      'feed_host_not_approved' | `feed_provider_mismatch_${FeedProfile}`,
    message: string,
  ) {
    super({ code, message });
  }
}
