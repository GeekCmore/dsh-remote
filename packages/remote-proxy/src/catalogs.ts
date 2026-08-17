/** Read-only local service facades over the daemon's `catalog.list` methods. */
import { Service, type Context } from '@deepseek-ai/cordis';
import type {
  AgentPresetSummary,
  ModelProviderGroup,
  RemoteClient,
  SkillSummary,
} from '@dsh-remote/client';

export class RemoteLlmCatalog extends Service {
  private providers: ModelProviderGroup[] = [];

  constructor(
    ctx: Context,
    private readonly client: RemoteClient,
    private readonly targetId: string,
  ) {
    super(ctx, 'llm');
  }

  listProviders(): { id: string; name: string }[] {
    return this.providers.map(({ provider }) => ({ id: provider, name: provider }));
  }

  async listModels(provider: string): Promise<
    { provider: string; id: string; name: string }[]
  > {
    await this.refresh();
    const group = this.providers.find((item) => item.provider === provider);
    return (group?.models ?? []).map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
    }));
  }

  async refresh(): Promise<void> {
    const result = await this.client.listCatalog(this.targetId, 'models');
    this.providers = result.providers;
    this.ctx.emit('llm/adapters-updated');
  }
}

export class RemoteSkillsCatalog extends Service {
  private skills: SkillSummary[] = [];

  constructor(
    ctx: Context,
    private readonly client: RemoteClient,
    private readonly targetId: string,
  ) {
    super(ctx, 'skills');
  }

  async list(): Promise<SkillSummary[]> {
    const result = await this.client.listCatalog(this.targetId, 'skills');
    this.skills = result.skills;
    return this.skills.map((skill) => ({ ...skill }));
  }
}

export class RemoteAgentPresetsCatalog extends Service {
  private presets: AgentPresetSummary[] = [];

  constructor(
    ctx: Context,
    private readonly client: RemoteClient,
    private readonly targetId: string,
  ) {
    super(ctx, 'agentPresets');
  }

  get defaultId(): string {
    return this.presets.find((preset) => preset.isDefault)?.id ?? '';
  }

  async list(): Promise<
    { id: string; name: string; description?: string }[]
  > {
    const result = await this.client.listCatalog(this.targetId, 'agentPresets');
    this.presets = result.agentPresets;
    return this.presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      ...(preset.description !== undefined ? { description: preset.description } : {}),
    }));
  }
}

export class RemoteCatalogs {
  readonly llm: RemoteLlmCatalog;
  readonly skills: RemoteSkillsCatalog;
  readonly agentPresets: RemoteAgentPresetsCatalog;
  /** Best-effort preload for synchronous model-provider discovery. */
  readonly ready: Promise<void>;

  constructor(ctx: Context, client: RemoteClient, targetId: string) {
    this.llm = new RemoteLlmCatalog(ctx, client, targetId);
    this.skills = new RemoteSkillsCatalog(ctx, client, targetId);
    this.agentPresets = new RemoteAgentPresetsCatalog(ctx, client, targetId);
    this.ready = Promise.allSettled([
      this.llm.refresh(),
      this.skills.list(),
      this.agentPresets.list(),
    ]).then(() => undefined);
  }
}
