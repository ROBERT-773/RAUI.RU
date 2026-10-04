import {
  Injectable,
  Module,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Headers,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentActor,
  Idempotency,
  parse,
  seller,
  uuid,
} from '../../common/security';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
@Injectable()
export class Organizations {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
  ) {}
  async permission(
    actor: Actor,
    id: string,
    manage = false,
    sql: Sql = this.db.pool,
  ) {
    const [row] = await this.db.rows<{
      kind: 'agency' | 'developer';
      role: string;
    }>(
      `SELECT o.kind,m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE o.id=$1 AND o.active AND m.user_id=$2 AND m.active FOR SHARE OF o,m`,
      [parse(uuid, id), actor.id],
      sql,
    );
    if (!row || (manage && !['owner', 'admin'].includes(row.role)))
      throw new ForbiddenException('Active organization membership required');
    return row;
  }
  async create(actor: Actor, body: unknown, key: unknown) {
    seller(actor);
    const input = parse(
      z
        .object({
          name: z.string().trim().min(2).max(200),
          kind: z.enum(['agency', 'developer']),
        })
        .strict(),
      body,
    );
    if (
      !['agency', 'developer', 'admin'].includes(actor.role) ||
      (actor.role !== input.kind && actor.role !== 'admin')
    )
      throw new ForbiddenException('Matching professional role required');
    return this.idem.run(actor, 'org.create', key, input, async (sql) => {
      const [org] = await this.db.rows<{ id: string }>(
        'INSERT INTO organizations(name,kind,created_by) VALUES($1,$2,$3) RETURNING *',
        [input.name, input.kind, actor.id],
        sql,
      );
      await sql.query(
        "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
        [org!.id, actor.id],
      );
      await this.audit.record(
        sql,
        actor.id,
        'organization.created',
        'organization',
        org!.id,
        input,
      );
      return org!;
    });
  }
  async mine(actor: Actor) {
    return this.db.rows(
      'SELECT o.*,m.role AS membership_role,m.active AS membership_active FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.created_at DESC LIMIT 100',
      [actor.id],
    );
  }
  async members(actor: Actor, id: string) {
    await this.permission(actor, id);
    return this.db.rows(
      'SELECT m.user_id,m.role,m.active,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE organization_id=$1 ORDER BY m.created_at LIMIT 100',
      [id],
    );
  }
  async setMember(actor: Actor, id: string, body: unknown) {
    const input = parse(
      z
        .object({
          userId: uuid,
          role: z.enum(['admin', 'member']),
          active: z.boolean(),
        })
        .strict(),
      body,
    );
    if (input.userId === actor.id)
      throw new ForbiddenException('Cannot alter own membership');
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [
        parse(uuid, id),
      ]);
      const permission = await this.permission(actor, id, true, sql);
      const [target] = await this.db.rows<{ role: string }>(
        'SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2',
        [id, input.userId],
        sql,
      );
      if (
        target?.role === 'owner' ||
        (permission.role === 'admin' &&
          (input.role === 'admin' || target?.role === 'admin'))
      )
        throw new ForbiddenException('Only owner may manage administrators');
      const [user] = await this.db.rows(
        'SELECT id FROM users WHERE id=$1 AND active AND email_verified_at IS NOT NULL AND phone_verified_at IS NOT NULL',
        [input.userId],
        sql,
      );
      if (!user) throw new NotFoundException('Verified user required');
      await sql.query(
        'INSERT INTO memberships(organization_id,user_id,role,active) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,user_id) DO UPDATE SET role=$3,active=$4',
        [id, input.userId, input.role, input.active],
      );
      await this.audit.record(
        sql,
        actor.id,
        'membership.changed',
        'organization',
        id,
        input,
      );
      return input;
    });
  }
}
@Controller('v1/organizations')
export class OrganizationController {
  constructor(private readonly organizations: Organizations) {}
  @Post() create(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.organizations.create(actor, body, key);
  }
  @Get() mine(@CurrentActor() actor: Actor) {
    return this.organizations.mine(actor);
  }
  @Get(':id/members') members(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ) {
    return this.organizations.members(actor, id);
  }
  @Patch(':id/members') member(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.organizations.setMember(actor, id, body);
  }
}
@Module({
  controllers: [OrganizationController],
  providers: [Organizations, Idempotency],
  exports: [Organizations],
})
export class OrganizationsModule {}
