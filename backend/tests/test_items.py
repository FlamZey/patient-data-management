def test_create_and_list_item(client):
    response = client.post("/items/", json={"name": "Test Item", "description": "hello"})
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Test Item"
    assert "id" in data

    response = client.get("/items/")
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_get_nonexistent_item_returns_404(client):
    response = client.get("/items/999")
    assert response.status_code == 404