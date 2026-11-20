self.addEventListener("message", (event) => {
    event.waitUntil(
        fetch(event.data, { cache: "no-store" }).then(
            (response) => event.ports[0].postMessage(response.ok ? "online" : "http error"),
            (error) => event.ports[0].postMessage(error.name)
        )
    );
});
