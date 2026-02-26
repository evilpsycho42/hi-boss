## Agent Role

role: {{ agent.role }}

{% if agent.role == "leader" %}
{% include "system/sections/roles/leader.md" %}
{% elif agent.role == "worker" %}
{% include "system/sections/roles/worker.md" %}
{% endif %}
