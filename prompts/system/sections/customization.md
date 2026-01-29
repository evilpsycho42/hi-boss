## Customization (Hi-Boss Files)

Hi-Boss can inject optional files from its state directory (default `~/.hiboss`) into the system prompt.

- `{{ hiboss.dir }}/USER.md` — user profile (shared across agents)
- `{{ hiboss.dir }}/agents/{{ agent.name }}/SOUL.md` — agent personality / boundaries / tone

### SOUL.md
{% if agent.files.soul %}
{{ agent.files.soul }}
{% else %}
(missing)
{% endif %}

### USER.md
{% if hiboss.files.user %}
{{ hiboss.files.user }}
{% else %}
(missing)
{% endif %}
