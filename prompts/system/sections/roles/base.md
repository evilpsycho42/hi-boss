## Agent Role

role: {{ agent.role }}

{% if agent.role == "speaker" %}
{% include "system/sections/roles/speaker.md" %}
{% elif agent.role == "leader" %}
{% include "system/sections/roles/leader.md" %}
{% endif %}
