import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Actor, CurrentActor } from '../../common/security';
import { ProfessionalImports } from './imports';
import type { ProfessionalFeeds } from './feeds';
import { Inject } from '@nestjs/common';

// Inject by alias to keep controller and module free of circular runtime imports.
export const personalFeedService = Symbol('PersonalFeedService');

@Controller('v1/account/feeds')
export class PersonalFeedController {
  constructor(
    @Inject(personalFeedService) private readonly feeds: ProfessionalFeeds,
    private readonly imports: ProfessionalImports,
  ) {}

  @Get('links') links(@CurrentActor() actor: Actor) {
    return this.feeds.links(actor, null);
  }

  @Post('link') connect(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.feeds.createFromLink(actor, null, body, key);
  }

  @Get(':feedId/runs/:runId') report(
    @CurrentActor() actor: Actor,
    @Param('feedId') feed: string,
    @Param('runId') run: string,
  ) {
    return this.imports.report(actor, null, feed, run);
  }

  @Get(':feedId/runs/:runId/items') items(
    @CurrentActor() actor: Actor,
    @Param('feedId') feed: string,
    @Param('runId') run: string,
    @Query() query: unknown,
  ) {
    return this.imports.items(actor, null, feed, run, query);
  }
}
