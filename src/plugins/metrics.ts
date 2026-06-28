import { FastifyInstance } from 'fastify';
import fastifyMetrics from 'fastify-metrics';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    customMetrics: {
      orderBookDepth: any;
      tradeVolume: any;
    };
  }
}

export default fp(async function metricsPlugin(fastify: FastifyInstance) {
  await fastify.register(fastifyMetrics, {
    endpoint: '/metrics',
    defaultMetrics: { enabled: true },
    routeMetrics: { enabled: true },
  } as any);

  const { client } = (fastify as any).metrics;

  const orderBookDepth = new client.Gauge({
    name: 'novabit_order_book_depth',
    help: 'Total number of orders in the order book',
    labelNames: ['pair', 'side'],
  });

  const tradeVolume = new client.Counter({
    name: 'novabit_trade_volume_total',
    help: 'Total volume of trades',
    labelNames: ['pair'],
  });

  fastify.decorate('customMetrics', {
    orderBookDepth,
    tradeVolume,
  });
});
