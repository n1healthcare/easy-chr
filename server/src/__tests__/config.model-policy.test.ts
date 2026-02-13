import { afterEach, describe, expect, it } from 'vitest';

describe('defaults-only model policy', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('ignores env model overrides and reports them in inventory', async () => {
    process.env.MARKDOWN_MODEL = 'override-markdown-model';
    process.env.INTERMEDIATE_MODEL = 'override-intermediate-model';
    process.env.HTML_MODEL = 'override-html-model';
    process.env.DOCTOR_MODEL = 'override-doctor-model';

    const { REALM_CONFIG, getModelInventory } = await import('../config.js');
    const inventory = getModelInventory();

    expect(inventory.policy).toBe('defaults_only');
    expect(REALM_CONFIG.models.markdown).toBe('gemini-2.5-flash');
    expect(REALM_CONFIG.models.intermediate).toBe('gemini-3-pro-preview');
    expect(REALM_CONFIG.models.html).toBe('gemini-3-flash-preview');
    expect(REALM_CONFIG.models.doctor).toBe('gemini-3-pro-preview');
    expect(inventory.ignoredEnvOverrides).toEqual({
      MARKDOWN_MODEL: 'override-markdown-model',
      INTERMEDIATE_MODEL: 'override-intermediate-model',
      HTML_MODEL: 'override-html-model',
      DOCTOR_MODEL: 'override-doctor-model',
    });
  });
});
