{% if envelope.lastDeliveryError %}
last-delivery-error-at: {{ envelope.lastDeliveryError.at }}
{% if envelope.lastDeliveryError.kind %}
last-delivery-error-kind: {{ envelope.lastDeliveryError.kind }}
{% endif %}
{% if envelope.lastDeliveryError.message %}
last-delivery-error-message: {{ envelope.lastDeliveryError.message }}
{% endif %}
{% endif %}
