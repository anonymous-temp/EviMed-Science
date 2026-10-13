"""A tiny shopping cart."""
from pricing import apply_discount, with_tax


class Cart:
    def __init__(self):
        self.items = []

    def add(self, name: str, price: float, qty: int = 1) -> None:
        self.items.append((name, price, qty))

    def subtotal(self) -> float:
        return round(sum(price * qty for _, price, qty in self.items), 2)

    def total(self, discount_percent: float = 0.0, taxed: bool = False) -> float:
        value = self.subtotal()
        if discount_percent:
            value = apply_discount(value, discount_percent)
        return with_tax(value) if taxed else value
