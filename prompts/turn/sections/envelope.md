{% if showHeader %}
### Envelope {{ envelopeBlockIndex }}

from: {{ envelope.from }}
{% if envelope.fromName %}
from-name: {{ envelope.fromName }}
{% endif %}
{% if envelope.isGroup == false %}

{% endif %}
{% endif %}
{% if isContinuation %}


{% endif %}
{% if envelope.channelMessageId %}
channel-message-id: {{ envelope.channelMessageId }}
{% endif %}
{% if envelope.isGroup == false %}
created-at: {{ envelope.createdAt.localIso }}
{% endif %}
{% if envelope.deliverAt.utcIso %}
deliver-at: {{ envelope.deliverAt.localIso }}
{% endif %}
{% if envelope.inReplyTo %}
in-reply-to-channel-message-id: {{ envelope.inReplyTo.channelMessageId }}
{% if envelope.inReplyTo.fromName %}
in-reply-to-from-name: {{ envelope.inReplyTo.fromName }}
{% endif %}
in-reply-to-text:
{{ envelope.inReplyTo.text }}
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
