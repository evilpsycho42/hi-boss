from: {{ envelope.from }}
{% if envelope.senderLine %}
sender: {{ envelope.senderLine }}
{% endif %}
{% if envelope.channelMessageId %}
channel-message-id: {{ envelope.channelMessageId }}
{% endif %}
created-at: {{ envelope.createdAt.localIso }}
{% if envelope.deliverAt.utcIso %}
deliver-at: {{ envelope.deliverAt.localIso }}
{% endif %}
{% if envelope.cronId %}
cron-id: {{ envelope.cronId }}
{% endif %}
{% if envelope.inReplyTo %}
in-reply-to-channel-message-id: {{ envelope.inReplyTo.channelMessageId }}
{% if envelope.inReplyTo.fromName %}
in-reply-to-from-name: {{ envelope.inReplyTo.fromName }}
{% endif %}
in-reply-to-text:
{{ envelope.inReplyTo.text }}
{% endif %}

{{ envelope.content.text }}
{% if envelope.content.attachmentsText != "(none)" %}
attachments:
{{ envelope.content.attachmentsText }}
{% endif %}
