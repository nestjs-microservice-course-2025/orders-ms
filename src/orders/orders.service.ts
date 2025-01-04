import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { PrismaClient } from '@prisma/client';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { OrderPaginationDto } from './dto/order-pagination.dto';
import { ChangeOrderStatusDto } from './dto/change-order-status.dto';
import { NATS_SERVICE } from 'src/config';
import { firstValueFrom } from 'rxjs';
import { OrderWithProducts } from './interfaces/order-with-products.interface';

@Injectable()
export class OrdersService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  constructor(@Inject(NATS_SERVICE) private readonly natsClient: ClientProxy) {
    super();
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to database');
  }
  async create(createOrderDto: CreateOrderDto) {
    try {
      //1. Confirmar que los productos existen
      const productIds = createOrderDto.items.map((item) => item.productId);
      const products = await firstValueFrom(
        this.natsClient.send({ cmd: 'validate_products' }, productIds),
      );
      // return products;

      //2. Calcular los totales de productos
      const totalAmount = createOrderDto.items.reduce((acc, orderItem) => {
        const price = products.find(
          (product) => product.id === orderItem.productId,
        ).price;
        return acc + price * orderItem.quantity;
      }, 0);

      const totalItems = createOrderDto.items.reduce((acc, orderItem) => {
        return acc + orderItem.quantity;
      }, 0);

      //3. Crear una transaccion de base de datos
      const order = await this.order.create({
        data: {
          totalAmount: totalAmount,
          totalItems: totalItems,
          OrderItem: {
            createMany: {
              data: createOrderDto.items.map((orderItem) => ({
                price: products.find(
                  (product) => product.id === orderItem.productId,
                ).price,
                productId: orderItem.productId,
                quantity: orderItem.quantity,
              })),
            },
          },
        },
        include: {
          OrderItem: {
            select: {
              productId: true,
              quantity: true,
              price: true,
            },
          },
        },
      });

      return {
        ...order,
        OrderItem: order.OrderItem.map((orderItem) => ({
          ...orderItem,
          name: products.find((product) => product.id === orderItem.productId)
            .name,
        })),
      };
    } catch (error) {
      throw new RpcException({
        message: `Products could not be validated: ${error.message}`,
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });
    }

    // return { service: 'orders', data: createOrderDto };
    // return this.order.create({ data: createOrderDto });
  }

  async findAll(orderPaginationDto: OrderPaginationDto) {
    const {
      page: currentPage,
      limit: ordersPerPage,
      status,
    } = orderPaginationDto;

    const totalOrders = await this.order.count({
      where: {
        status: status,
      },
    });
    const lastPage = Math.ceil(totalOrders / ordersPerPage);

    return {
      data: await this.order.findMany({
        take: ordersPerPage,
        skip: (currentPage - 1) * ordersPerPage,
        where: {
          status: status,
        },
      }),
      meta: {
        totalOrders,
        currentPage,
        lastPage,
      },
    };
  }

  async findOne(id: string) {
    const order = await this.order
      .findUniqueOrThrow({
        where: {
          id,
        },
        include: {
          OrderItem: {
            select: {
              productId: true,
              quantity: true,
              price: true,
            },
          },
        },
      })
      .catch((error) => {
        this.logger.error(error);
        throw new RpcException({
          message: `Order with id #${id} not found`,
          status: HttpStatus.NOT_FOUND,
        });
      });

    const productIds = order.OrderItem.map((orderItem) => orderItem.productId);
    const products = await firstValueFrom(
      this.natsClient.send({ cmd: 'validate_products' }, productIds),
    );

    return {
      ...order,
      OrderItem: order.OrderItem.map((orderItem) => ({
        ...orderItem,
        name: products.find((product) => product.id === orderItem.productId)
          .name,
      })),
    };
  }

  async chageOrderStatus(changeOrderStatusDto: ChangeOrderStatusDto) {
    const { id, status } = changeOrderStatusDto;
    const order = await this.findOne(id);

    if (order.status === status) {
      throw new RpcException({
        message: `Order with id #${id} already has status ${status}`,
        status: HttpStatus.BAD_REQUEST,
      });
    }

    return this.order.update({
      where: { id: id },
      data: {
        status: status,
      },
    });
  }

  async createPaymentSession(order: OrderWithProducts) {
    const paymentSession = await firstValueFrom(
      this.natsClient.send('create.payment.session', {
        orderId: order.id,
        currency: 'usd',
        items: [{ name: 'Producto hardcodeado', price: 50.5, quantity: 1 }],
      }),
    );
    return paymentSession;
  }
}
