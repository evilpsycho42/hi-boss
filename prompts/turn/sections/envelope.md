### Envelope {{ envelope.index }}

id: {{ envelope.id }}
from: {{ envelope.from }}
{% if envelope.fromName %}
from-name: {{ envelope.fromName }}
{% endif %}
from-boss: {{ envelope.fromBoss }}
created-at: {{ envelope.createdAt.localIso }}

text:
{{ envelope.content.text }}

attachments:
{{ envelope.content.attachmentsText }}

