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
- **Long-term memory (auto-injected)**: {{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/MEMORY.md
- **Daily memory dir**: {{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/memories/
- **Provider**: {{ agent.provider }}
- **Provider home**: {% if agent.provider == "claude" %}~/.claude{% elif agent.provider == "codex" %}~/.codex{% else %}~/.claude / ~/.codex{% endif %} (shared; user-managed)
{% if bindings.length %}
- **Adapters**: {% for b in bindings %}{{ b.adapterType }}{% if not loop.last %}, {% endif %}{% endfor %}{{ "" }}
{% endif %}
