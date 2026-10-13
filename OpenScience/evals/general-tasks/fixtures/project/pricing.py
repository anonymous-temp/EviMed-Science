"""Price helpers for the demo shop."""


def apply_discount(price: float, percent: float) -> float:
    """Return the price after taking `percent` percent off."""
    return round(price * (percent / 100), 2)


def with_tax(price: float, rate: float = 0.13) -> float:
    return round(price * (1 + rate), 2)
