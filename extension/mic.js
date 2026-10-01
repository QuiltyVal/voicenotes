// Microphone permission must be granted once on an extension page; the offscreen recorder can't ask.
navigator.mediaDevices.getUserMedia({ audio: true }).then(
  (stream) => {
    stream.getTracks().forEach((t) => t.stop());
    document.getElementById("status").textContent = "Готово! Микрофон разрешён, эту вкладку можно закрыть.";
  },
  () => {
    document.getElementById("status").textContent =
      "Доступ не дан. Нажми на значок замка или микрофона в адресной строке, разреши микрофон и обнови страницу.";
  },
);
