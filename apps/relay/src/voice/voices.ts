export interface VoiceProfile {
  id: string;
  name: string;
  settings: { stability: number; similarity_boost: number; style: number; speed: number; use_speaker_boost: boolean };
}

const base = { stability: 0.55, similarity_boost: 0.75, style: 0, speed: 1, use_speaker_boost: true };

/** Premade ElevenLabs voices, one per team, chosen to be distinguishable by ear on a noisy field. */
const PROFILES: Record<string, VoiceProfile> = {
  medics: { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', settings: { ...base, stability: 0.65 } },
  access: { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', settings: { ...base, speed: 0.97 } },
  facilities: { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', settings: { ...base, stability: 0.6 } },
  supply: { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', settings: { ...base } },
  system: { id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Bella', settings: { ...base, stability: 0.7 } },
};

export const VOICE_ROLES = Object.keys(PROFILES);

export function voiceFor(role: string): VoiceProfile {
  const key = role.trim().toLowerCase();
  const override = process.env[`ELEVENLABS_VOICE_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  const profile = PROFILES[key] ?? PROFILES.system;
  return override ? { ...profile, id: override } : profile;
}

export const TTS_MODEL = 'eleven_flash_v2_5';
export const STT_MODEL = 'scribe_v2';
