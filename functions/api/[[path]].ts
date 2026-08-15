interface OnlineServiceBinding {
  fetch(request: Request): Promise<Response>
}

interface PagesApiContext {
  request: Request
  env: {
    ONLINE_SERVICE: OnlineServiceBinding
  }
}

export function onRequest(context: PagesApiContext): Promise<Response> {
  return context.env.ONLINE_SERVICE.fetch(context.request)
}
