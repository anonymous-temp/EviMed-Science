/** Await an unref'ed background monitor without depending on unrelated I/O. */
export async function awaitBackgroundMonitor(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Background monitor did not settle within 30 seconds.")), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
