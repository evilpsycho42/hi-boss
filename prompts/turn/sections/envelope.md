{% if showHeader %}
### Envelope {{ envelopeBlockIndex }}

from: {{ envelope.from }}
{% if envelope.fromName %}
from-name: {{ envelope.fromName }}
{% endif %}
{% if envelope.isGroup == false %}
created-at: {{ envelope.createdAt.localIso }}
{% endif %}
{% endif %}

{% if isContinuation %}

{% endif %}

{% if envelope.isGroup %}
{{ envelope.authorLine }} at {{ envelope.createdAt.localIso }}:
{{ envelope.content.text }}
{% if envelope.content.attachmentsText != "(none)" %}
attachments:
{{ envelope.content.attachmentsText }}
{% endif %}
{% else %}
text:
{{ envelope.content.text }}
{% if envelope.content.attachmentsText != "(none)" %}
attachments:
{{ envelope.content.attachmentsText }}
{% endif %}
{% endif %}
