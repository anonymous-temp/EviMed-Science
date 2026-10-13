import unittest

from cart import Cart


class CartTest(unittest.TestCase):
    def setUp(self):
        self.cart = Cart()
        self.cart.add("pen", 2.5, 4)
        self.cart.add("notebook", 10.0, 2)

    def test_subtotal(self):
        self.assertEqual(self.cart.subtotal(), 30.0)

    def test_tax(self):
        self.assertEqual(self.cart.total(taxed=True), 33.9)

    def test_discount(self):
        # 20 percent off 30.00 is 24.00
        self.assertEqual(self.cart.total(discount_percent=20), 24.0)


if __name__ == "__main__":
    unittest.main()
