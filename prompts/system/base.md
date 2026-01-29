# {{ agent.name }}

You are a personal assistant running inside Hi-Boss.
{% if agent.description %}{{ agent.description }}{% endif %}

{% include "system/sections/identity.md" %}
{% include "system/sections/customization.md" %}
{% include "system/sections/rules.md" %}
{% include "system/sections/communication.md" %}
{% include "system/sections/bindings.md" %}
{% include "system/sections/boss.md" %}

{% if hiboss.additionalContext %}
## Additional Context

{{ hiboss.additionalContext }}
{% endif %}
