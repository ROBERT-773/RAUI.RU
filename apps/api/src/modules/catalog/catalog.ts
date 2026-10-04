import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  Injectable,
  Module,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AdminOnly,
  Actor,
  CurrentActor,
  Public,
  parse,
} from '../../common/security';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
export const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/);
export interface Attribute {
  code: string;
  kind: 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  options: string[];
}
export function validateAttributes(
  definitions: Attribute[],
  values: Record<string, unknown>,
  complete = false,
) {
  for (const code of Object.keys(values)) {
    const definition = definitions.find((d) => d.code === code);
    if (!definition)
      throw new BadRequestException(`Unknown attribute: ${code}`);
    const value = values[code];
    const valid =
      definition.kind === 'enum'
        ? typeof value === 'string' && definition.options.includes(value)
        : typeof value === definition.kind;
    if (
      !valid ||
      (typeof value === 'number' &&
        (!Number.isFinite(value) || (code === 'area' && value <= 0))) ||
      (typeof value === 'string' && value.length > 2000)
    )
      throw new BadRequestException(`Invalid attribute: ${code}`);
  }
  if (complete)
    for (const definition of definitions)
      if (definition.required && !(definition.code in values))
        throw new BadRequestException(`Required attribute: ${definition.code}`);
}
@Injectable()
export class Catalog {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
  ) {}
  async definitions(category: string, sql: Sql = this.db.pool) {
    const [row] = await this.db.rows(
      'SELECT code FROM categories WHERE code=$1 AND active',
      [category],
      sql,
    );
    if (!row) throw new BadRequestException('Inactive or unknown category');
    return this.db.rows<Attribute>(
      'SELECT * FROM attribute_definitions WHERE category_code=$1 ORDER BY code',
      [category],
      sql,
    );
  }
  async list() {
    return this.db.rows('SELECT * FROM categories WHERE active ORDER BY code');
  }
  async configure(actor: Actor, category: string, body: unknown) {
    const input = parse(
      z
        .object({
          code: codeSchema,
          name: z.string().min(1).max(100),
          kind: z.enum(['string', 'number', 'boolean', 'enum']),
          required: z.boolean(),
          options: z.array(z.string().max(100)).max(100).default([]),
        })
        .strict(),
      body,
    );
    if (input.kind === 'enum' && input.options.length === 0)
      throw new BadRequestException('Enum options required');
    return this.db.transaction(async (sql) => {
      await sql.query(
        'INSERT INTO attribute_definitions(category_code,code,name,kind,required,options) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(category_code,code) DO UPDATE SET name=$3,kind=$4,required=$5,options=$6',
        [
          category,
          input.code,
          input.name,
          input.kind,
          input.required,
          JSON.stringify(input.options),
        ],
      );
      await this.audit.record(
        sql,
        actor.id,
        'catalog.attribute.configured',
        'category',
        category,
        input,
      );
      return input;
    });
  }
}
@Controller('v1/categories')
export class CatalogController {
  constructor(private readonly catalog: Catalog) {}
  @Public() @Get() list() {
    return this.catalog.list();
  }
  @Public() @Get(':code/attributes') definitions(@Param('code') code: string) {
    return this.catalog.definitions(parse(codeSchema, code));
  }
  @AdminOnly() @Put(':code/attributes') configure(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
    @Body() body: unknown,
  ) {
    return this.catalog.configure(actor, parse(codeSchema, code), body);
  }
}
@Module({
  controllers: [CatalogController],
  providers: [Catalog],
  exports: [Catalog],
})
export class CatalogModule {}
