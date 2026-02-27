## Environment

### Time
{% if environment.time %}
- **Current time**: {{ environment.time }}
{% endif %}
{% if environment.bossTimezone %}
- **Boss timezone**: {{ environment.bossTimezone }}
{% endif %}
{% if environment.daemonTimezone %}
- **Daemon timezone**: {{ environment.daemonTimezone }}
{% endif %}

### Paths
- **Workspace (effective)**: {{ agent.workspace }}
{% if agent.workspaceConfigured and agent.workspaceConfigured != agent.workspace %}
- **Workspace (agent configured)**: {{ agent.workspaceConfigured }}
{% endif %}
{% if workspace.teamDirs.length %}
- **Team workspaces (active)**: {% for dir in workspace.teamDirs %}{{ dir }}{% if not loop.last %}, {% endif %}{% endfor %}{{ "" }}
{% endif %}
{% if workspace.allDirs.length > 1 %}
- **Workspaces (all available)**: {% for dir in workspace.allDirs %}{{ dir }}{% if not loop.last %}, {% endif %}{% endfor %}{{ "" }}
{% endif %}
- **Teamspaces root**: {{ hiboss.dir }}/teamspaces/
- **Internal workspace**: {{ hiboss.dir }}/agents/{{ agent.name }}/
- **Long-term memory (auto-injected)**: {{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/MEMORY.md
- **Daily memory dir**: {{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/memories/
- **Provider**: {{ agent.provider }}
- **Provider home (default)**: {% if agent.provider == "claude" %}~/.claude{% elif agent.provider == "codex" %}~/.codex{% else %}~/.claude / ~/.codex{% endif %} (can be overridden per-agent via metadata provider env)
{% if bindings.length %}
- **Adapters**: {% for b in bindings %}{{ b.adapterType }}{% if not loop.last %}, {% endif %}{% endfor %}{{ "" }}
{% endif %}
