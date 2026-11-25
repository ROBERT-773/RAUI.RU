ALTER TABLE public_professional_profiles ADD COLUMN image_id uuid UNIQUE;

-- Once the profile drops its reference, the existing private-storage cleanup
-- worker may remove those bytes. Its queue is committed with the change.
CREATE FUNCTION queue_replaced_profile_image() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.image_id IS NOT DISTINCT FROM OLD.image_id THEN
    RETURN NULL;
  END IF;
  INSERT INTO professional_photo_cleanup(media_id,object_keys,available_at)
  VALUES (OLD.image_id,ARRAY['profile-images/' || OLD.image_id::text || '.webp'],clock_timestamp());
  RETURN NULL;
END;
$$;

CREATE TRIGGER replaced_professional_image AFTER UPDATE OF image_id OR DELETE ON public_professional_profiles
FOR EACH ROW WHEN (OLD.image_id IS NOT NULL) EXECUTE FUNCTION queue_replaced_profile_image();
