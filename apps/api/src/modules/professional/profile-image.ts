import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Put,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  type Actor,
  CurrentActor,
  parse,
  Public,
  uuid,
} from '../../common/security';
import { Database, type Sql } from '../database/database';
import { uploadSchema, validateImage } from '../media/media';
import { ObjectStorage } from '../media/storage';
import { Organizations } from '../organizations/organizations';
import { visibleProfessionals } from './public-profile-visibility';

export const professionalImageInput = uploadSchema
  .pick({ filename: true, mime: true, base64: true })
  .extend({ expectedImageId: uuid.nullable() })
  .strict();
const objectKey = (imageId: string) => `profile-images/${imageId}.webp`;
type Profile = { id: string; imageId: string | null };

@Injectable()
export class ProfessionalProfileImages {
  constructor(
    private readonly db: Database,
    private readonly organizations: Organizations,
    private readonly storage: ObjectStorage,
  ) {}

  private async editor(
    sql: Sql,
    actor: Actor,
    agencyId?: string,
  ): Promise<Profile> {
    // Match the profile editor's user → organization → membership → profile lock order.
    const [user] = await this.db.rows<{ role: string }>(
      "SELECT role FROM users WHERE id=$1 AND active AND registration_approval_state='approved' FOR SHARE",
      [actor.id],
      sql,
    );
    if (!user || (!agencyId && user.role !== 'agent'))
      throw new ForbiddenException();
    if (agencyId) {
      const permission = await this.organizations.permission(
        actor,
        agencyId,
        true,
        sql,
      );
      if (permission.kind !== 'agency') throw new ForbiddenException();
    }
    const column = agencyId ? 'agency_id' : 'agent_id';
    const [row] = await this.db.rows<Profile>(
      `SELECT id,image_id AS "imageId" FROM public_professional_profiles WHERE ${column}=$1 FOR UPDATE`,
      [agencyId ?? actor.id],
      sql,
    );
    if (!row) throw new NotFoundException('Сначала сохраните профиль.');
    return row;
  }

  private expectImage(profile: Profile, version: string | null) {
    if (profile.imageId !== version)
      throw new ConflictException(
        'Изображение уже изменилось. Обновите профиль.',
      );
  }

  async upload(actor: Actor, body: unknown, agencyId?: string) {
    const input = parse(professionalImageInput, body);
    await this.db.transaction(async (sql) =>
      this.expectImage(
        await this.editor(sql, actor, agencyId),
        input.expectedImageId,
      ),
    );
    const original = Buffer.from(input.base64, 'base64');
    await validateImage(original, input.mime, input.filename);
    const bytes = await sharp(original, { limitInputPixels: 40_000_000 })
      .autoOrient()
      .resize({
        width: 512,
        height: 512,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer()
      .catch(() => {
        throw new BadRequestException('Не удалось прочитать изображение.');
      });
    const imageId = randomUUID(),
      key = objectKey(imageId);
    // Reserve the new object before writing. A lost storage or commit response
    // leaves either the reference or a durable, retryable cleanup reservation.
    await this.db.rows(
      "INSERT INTO professional_photo_cleanup(media_id,object_keys,available_at) VALUES($1,$2,clock_timestamp()+interval '1 day')",
      [imageId, [key]],
    );
    try {
      await this.storage.put(key, bytes, 'image/webp').catch(() => {
        throw new ServiceUnavailableException(
          'Не удалось сохранить изображение.',
        );
      });
      return await this.db.transaction(async (sql) => {
        const profile = await this.editor(sql, actor, agencyId);
        this.expectImage(profile, input.expectedImageId);
        const consumed = await sql.query(
          'DELETE FROM professional_photo_cleanup WHERE media_id=$1 AND NOT cleaning AND available_at>clock_timestamp()',
          [imageId],
        );
        if (!consumed.rowCount)
          throw new ConflictException(
            'Срок загрузки истёк. Загрузите изображение повторно.',
          );
        await sql.query(
          'UPDATE public_professional_profiles SET image_id=$2 WHERE id=$1',
          [profile.id, imageId],
        );
        return { imageId };
      });
    } catch (error) {
      // On an ambiguous commit a promoted reference has no reservation to release.
      await this.db
        .rows(
          'UPDATE professional_photo_cleanup SET available_at=clock_timestamp() WHERE media_id=$1 AND NOT cleaning',
          [imageId],
        )
        .catch(() => console.error('profile_image_cleanup_deferred'));
      throw error;
    }
  }

  async remove(actor: Actor, id: string, agencyId?: string) {
    const version = parse(uuid, id);
    return this.db.transaction(async (sql) => {
      const profile = await this.editor(sql, actor, agencyId);
      this.expectImage(profile, version);
      await sql.query(
        'UPDATE public_professional_profiles SET image_id=NULL WHERE id=$1',
        [profile.id],
      );
      return { imageId: null };
    });
  }

  private async image(
    id: string,
    allowed: () => Promise<boolean>,
    res: Response,
  ) {
    if (!(await allowed())) throw new NotFoundException();
    let bytes: Buffer;
    try {
      bytes = await this.storage.get(objectKey(id));
    } catch {
      if (!(await allowed())) throw new NotFoundException();
      throw new ServiceUnavailableException('Изображение временно недоступно.');
    }
    // Visibility can change during remote storage access.
    if (!(await allowed())) throw new NotFoundException();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  }
  content(actor: Actor, id: string, res: Response, agencyId?: string) {
    const version = parse(uuid, id);
    return this.image(
      version,
      () =>
        this.db.transaction(
          async (sql) =>
            (await this.editor(sql, actor, agencyId)).imageId === version,
        ),
      res,
    );
  }
  publicContent(id: string, version: string, res: Response) {
    const args = [parse(uuid, id), parse(uuid, version)];
    return this.image(
      args[1]!,
      async () =>
        (
          await this.db.rows(
            `SELECT 1 ${visibleProfessionals} AND p.id=$1 AND p.image_id=$2 LIMIT 1`,
            args,
          )
        ).length > 0,
      res,
    );
  }
}

@Controller('v1/search')
export class ProfessionalProfileImageController {
  constructor(private readonly images: ProfessionalProfileImages) {}
  @Put(['professional-profile/image', 'professional-profile/agency/:id/image'])
  upload(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Param('id') agencyId?: string,
  ) {
    return this.images.upload(actor, body, agencyId);
  }
  @Delete([
    'professional-profile/image/:imageId',
    'professional-profile/agency/:id/image/:imageId',
  ])
  remove(
    @CurrentActor() actor: Actor,
    @Param('imageId') id: string,
    @Param('id') agencyId?: string,
  ) {
    return this.images.remove(actor, id, agencyId);
  }
  @Get([
    'professional-profile/image/:imageId',
    'professional-profile/agency/:id/image/:imageId',
  ])
  content(
    @CurrentActor() actor: Actor,
    @Param('imageId') id: string,
    @Res() res: Response,
    @Param('id') agencyId?: string,
  ) {
    return this.images.content(actor, id, res, agencyId);
  }
  @Public()
  @Get('professionals/:id/image/:imageId')
  publicImage(
    @Param('id') id: string,
    @Param('imageId') version: string,
    @Res() res: Response,
  ) {
    return this.images.publicContent(id, version, res);
  }
}
