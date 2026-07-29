-- The pre-plan unique index (broker, segment, exchange) outlived 0031, which
-- only replaced the index it knew by name. While it stood, a paid plan could
-- never be stored: it shares broker+segment+exchange with the free tier, so
-- every plan row was silently swallowed by ON CONFLICT DO NOTHING.
DROP INDEX IF EXISTS `charge_config_key_uq`;
