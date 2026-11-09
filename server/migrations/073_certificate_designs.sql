-- The certificate gets five ornate designs in place of the three plain styles.
ALTER TABLE certificate_designs DROP CONSTRAINT IF EXISTS certificate_designs_style_check;
UPDATE certificate_designs SET style = CASE style WHEN 'classic' THEN 'heritage' WHEN 'modern' THEN 'horizon' WHEN 'simple' THEN 'prestige' ELSE style END;
ALTER TABLE certificate_designs ADD CONSTRAINT certificate_designs_style_check
  CHECK (style IN ('heritage','prestige','executive','sovereign','horizon'));
