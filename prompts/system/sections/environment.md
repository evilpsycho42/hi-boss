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
- **Workspace**: {{ agent.workspace }}
- **Internal workspace**: {{ hiboss.dir }}/agents/{{ agent.name }}/
- **Auto-injected memory file**: {{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/MEMORY.md
- **Provider**: {{ agent.provider }}
{% if agent.provider == "codex" %}
- **Provider home**: {{ hiboss.dir }}/agents/{{ agent.name }}/codex_home/
- **Provider-private skills**: {{ hiboss.dir }}/agents/{{ agent.name }}/codex_home/skills/ (highest precedence)
{% elif agent.provider == "claude" %}
- **Provider home**: {{ hiboss.dir }}/agents/{{ agent.name }}/claude_home/
- **Provider-private skills**: {{ hiboss.dir }}/agents/{{ agent.name }}/claude_home/skills/ (highest precedence)
{% endif %}
- **Global skills**: {{ hiboss.dir }}/skills/ (excluding `.system`)
- **Built-in skills**: {{ hiboss.dir }}/skills/.system/ (managed by Hi-Boss)
- **Skill precedence**: provider-private > global > built-in
{% if bindings.length %}
- **Adapters**: {% for b in bindings %}{{ b.adapterType }}{% if not loop.last %}, {% endif %}{% endfor %}{{ "" }}
{% endif %}
