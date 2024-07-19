const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs').promises;

const app = express();
app.use(bodyParser.json());
app.use(cors());

const pool = new Pool({
  connectionString: 'postgresql://postgres:atrox123@localhost:5432/app',
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    client.release();

    if (!user || password !== user.password) {
      return res.status(400).json({ message: 'Email or password incorrect' });
    }

    res.json({ message: 'Login successful', token: 'dummy-token', user });
  } catch (error) {
    console.error('Error during login:', error.message, error.stack);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update user endpoint
app.put('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { email, password } = req.body;

  try {
    const client = await pool.connect();
    const query = 'UPDATE users SET email = $1, password = $2 WHERE id = $3 RETURNING *';
    const values = [email, password, id];
    const result = await client.query(query, values);
    client.release();

    if (result.rowCount > 0) {
      const updatedUser = result.rows[0];
      res.json(updatedUser);
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    console.error('Error updating user:', error.message);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/packs', upload.array('images', 10), async (req, res) => {
  const { brand, price, numberOfItems, category } = req.body;

  if (!brand || !numberOfItems || !price || !category) {
    return res.status(400).json({ message: 'Brand, number of items, price, and category are required' });
  }

  const images = req.files;
  const status = 'Not Sold';

  try {
    const client = await pool.connect();

    const randomLetters = [...Array(3)].map(() => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
    const randomNumber = Math.floor(10000 + Math.random() * 90000);
    const packId = `${randomLetters}${randomNumber}`;

    // Insert into packs table
    const packInsertResult = await client.query(
      'INSERT INTO packs (id, brand, price, status, number_of_items, category) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_date',
      [packId, brand, parseFloat(price), status, parseInt(numberOfItems), category]
    );
    const { id: insertedPackId, created_date } = packInsertResult.rows[0];

    // Insert into items table
    const itemQueries = [];
    for (let i = 0; i < numberOfItems; i++) {
      const itemId = `${packId}${String(i + 1).padStart(5, '0')}`;
      itemQueries.push(client.query('INSERT INTO items (id, pack_id) VALUES ($1, $2)', [itemId, insertedPackId]));
    }
    await Promise.all(itemQueries);

    // Insert into images table
    const imageQueries = images.map((image) => {
      return client.query('INSERT INTO images (pack_id, data) VALUES ($1, $2)', [insertedPackId, image.buffer]);
    });
    await Promise.all(imageQueries);

    client.release();

    res.json({ message: 'Pack and items added successfully', packId, created_date });
  } catch (error) {
    console.error('Error during pack creation:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/packs', async (req, res) => {
  try {
    const client = await pool.connect();
    const packsResult = await client.query('SELECT * FROM packs');
    const packs = packsResult.rows;

    const itemsResult = await client.query('SELECT * FROM items');
    const items = itemsResult.rows;

    const imagesResult = await client.query('SELECT id, pack_id, encode(data, \'base64\') as data FROM images');
    const images = imagesResult.rows;

    const packsWithItemsAndImages = packs.map(pack => {
      return {
        ...pack,
        items: items.filter(item => item.pack_id === pack.id),
        images: images.filter(image => image.pack_id === pack.id).map(image => ({
          id: image.id,
          data: image.data
        }))
      };
    });

    client.release();
    res.json(packsWithItemsAndImages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}); 

// Backend endpoint to fetch categories
app.get('/categories', async (req, res) => {
  try {
    const client = await pool.connect();
    
    // Query to fetch distinct categories from packs table
    const categoriesResult = await client.query('SELECT DISTINCT category FROM packs');
    const categories = categoriesResult.rows.map(row => row.category);

    client.release();
    res.json(categories);
  } catch (err) {
    console.error('Error fetching categories:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Endpoint to update pack details
app.put('/packs/:id', async (req, res) => {
  const { id } = req.params;
  const { brand, category, number_of_items, price } = req.body;

  if (!brand || !number_of_items || !price || !category) {
    return res.status(400).json({ message: 'Brand, number of items, price, and category are required' });
  }

  try {
    const client = await pool.connect();

    // Fetch current pack details
    const packQuery = 'SELECT status, number_of_items FROM packs WHERE id = $1';
    const packResult = await client.query(packQuery, [id]);
    const pack = packResult.rows[0];

    if (!pack) {
      res.status(404).json({ error: 'Pack not found' });
      client.release();
      return;
    }

    // Check if the pack status is 'Sold' and validate the price
    if (pack.status === 'Sold') {
      const transactionQuery = 'SELECT amount FROM Transactions WHERE pack_id = $1';
      const transactionResult = await client.query(transactionQuery, [id]);
      const transaction = transactionResult.rows[0];

      if (!transaction) {
        res.status(400).json({ error: 'No transaction found for the pack' });
        client.release();
        return;
      }

      const amount = parseFloat(transaction.amount); // Ensure amount is a number
      const newPrice = parseFloat(price); // Ensure price is a number

      if (newPrice >= amount) { // Updated condition
        res.status(400).json({ error: 'Price must be smaller than the amount in transactions' }); 
        client.release();
        return;
      }
    }

    // Fetch existing item IDs
    const existingItemsQuery = 'SELECT id FROM items WHERE pack_id = $1';
    const existingItemsResult = await client.query(existingItemsQuery, [id]);
    const existingItemIds = existingItemsResult.rows.map(row => row.id);

    // Determine the number of items to add or remove
    const currentNumberOfItems = pack.number_of_items;
    const newNumberOfItems = parseInt(number_of_items, 10);
    const difference = newNumberOfItems - currentNumberOfItems;

    // Handle item changes
    if (difference > 0) {
      // Add new items
      const itemQueries = [];
      for (let i = 0; i < difference; i++) {
        const newItemId = `${id}${String(currentNumberOfItems + i + 1).padStart(5, '0')}`;
        // Only add item if it doesn't already exist
        if (!existingItemIds.includes(newItemId)) {
          itemQueries.push(client.query('INSERT INTO items (id, pack_id) VALUES ($1, $2)', [newItemId, id]));
        }
      }
      await Promise.all(itemQueries);
    } else if (difference < 0) {
      // Remove items
      const itemsToRemove = -difference; // Number of items to remove
      await client.query(`
        DELETE FROM items
        WHERE pack_id = $1
        AND id IN (
          SELECT id
          FROM items
          WHERE pack_id = $1
          ORDER BY id
          LIMIT $2
        )
      `, [id, itemsToRemove]);
    }

    // Update the pack details
    const updatePackQuery = `
      UPDATE packs
      SET brand = $1, category = $2, number_of_items = $3, price = $4, created_date = NOW()
      WHERE id = $5
      RETURNING *
    `;
    const result = await client.query(updatePackQuery, [brand, category, newNumberOfItems, price, id]);
    const updatedPack = result.rows[0];

    client.release();

    res.status(200).json(updatedPack);
  } catch (err) {
    console.error('Error updating pack:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/items/:id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body; // Only password is required

  try {
    const client = await pool.connect();

    // Authenticate the user based on password
    const userQuery = 'SELECT * FROM users WHERE password = $1';
    const userResult = await client.query(userQuery, [password]);
    const user = userResult.rows[0];

    if (!user) {
      client.release();
      return res.status(400).json({ message: 'Password incorrect. Access denied.' });
    }

    // Get pack_id for cascading deletion
    const packIdQuery = 'SELECT pack_id FROM items WHERE id = $1';
    const packIdResult = await client.query(packIdQuery, [id]);
    const packId = packIdResult.rows[0]?.pack_id;

    if (!packId) {
      client.release();
      return res.status(404).json({ message: 'Item not found' });
    }

    // Delete the item
    const deleteItemQuery = 'DELETE FROM items WHERE id = $1';
    const deleteItemResult = await client.query(deleteItemQuery, [id]);

    // Check if the deletion was successful
    if (deleteItemResult.rowCount === 0) {
      client.release();
      return res.status(404).json({ message: 'Item not found' });
    }

    // Update the number of items in the pack
    const updateItemCountQuery = 'UPDATE packs SET number_of_items = number_of_items - 1 WHERE id = $1';
    await client.query(updateItemCountQuery, [packId]);

    // Check if the pack has any remaining items
    const itemCountQuery = 'SELECT number_of_items FROM packs WHERE id = $1';
    const itemCountResult = await client.query(itemCountQuery, [packId]);
    const remainingItemCount = parseInt(itemCountResult.rows[0].number_of_items);

    // If no items remain in the pack, delete associated images and transactions
    if (remainingItemCount === 0) {
      await client.query('DELETE FROM images WHERE pack_id = $1', [packId]);
      await client.query('DELETE FROM transactions WHERE pack_id = $1', [packId]);
      // Delete the pack itself
      await client.query('DELETE FROM packs WHERE id = $1', [packId]);
    }

    client.release();
    res.json({ success: true, message: 'Item deleted successfully' });

  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/items', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM items');
    const items = result.rows;
    client.release();
    res.json(items);
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/items/:id', async (req, res) => {
  const { id } = req.params;
  const { email, password } = req.body;

  try {
    const client = await pool.connect();
    const userQuery = 'SELECT * FROM users WHERE email = $1';
    const userResult = await client.query(userQuery, [email]);
    const user = userResult.rows[0];

    if (!user) {
      client.release();
      return res.status(400).json({ message: 'Email or password incorrect' });
    }

    // Compare the provided password with the hashed password from the database
    const passwordMatch = await compare(password, user.password);
    if (!passwordMatch) {
      client.release();
      return res.status(400).json({ message: 'Email or password incorrect' });
    }

    // Get pack_id for cascading deletion
    const packIdQuery = 'SELECT pack_id FROM items WHERE id = $1';
    const packIdResult = await client.query(packIdQuery, [id]);
    const packId = packIdResult.rows[0].pack_id;

    // Delete the item
    await client.query('DELETE FROM items WHERE id = $1', [id]);

    // Check if the pack has any remaining items
    const itemCountQuery = 'SELECT COUNT(*) FROM items WHERE pack_id = $1';
    const itemCountResult = await client.query(itemCountQuery, [packId]);
    const remainingItemCount = parseInt(itemCountResult.rows[0].count);

    // If no items remain in the pack, delete the pack
    if (remainingItemCount === 0) {
      // Delete associated images due to ON DELETE CASCADE
      await client.query('DELETE FROM images WHERE pack_id = $1', [packId]);
      await client.query('DELETE FROM transactions WHERE pack_id = $1', [packId]);
      // Delete the pack itself
      await client.query('DELETE FROM packs WHERE id = $1', [packId]);
    }

    client.release();
    res.json({ success: true, message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/images/delete', async (req, res) => {
  const { imageIds } = req.body;

  if (!Array.isArray(imageIds) || imageIds.length === 0) {
    return res.status(400).json({ message: 'Invalid image IDs.' });
  }

  try {
    const client = await pool.connect();
    const deleteImagesQuery = 'DELETE FROM images WHERE id = ANY($1::int[])';
    const result = await client.query(deleteImagesQuery, [imageIds]);
    client.release();

    res.json({ message: 'Images deleted successfully', deletedCount: result.rowCount });
  } catch (err) {
    console.error('Error deleting images:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Route to filter items by name or ID
app.get('/items/search', (req, res) => {
  const { q } = req.query; // Assuming 'q' is the search query
  if (!q) {
    res.status(400).json({ message: 'Search query parameter "q" is required' });
    return;
  }

  const filteredItems = items.filter(item =>
    item.id.toString().toLowerCase().includes(q.toLowerCase()) ||
    item.pack_id.toString().toLowerCase().includes(q.toLowerCase())
  );

  res.json(filteredItems);
});

app.post('/packs/:id/sold', async (req, res) => {
  const { id } = req.params;
  const { amount, password } = req.body; // Extract amount and password from request body

  try {
    const client = await pool.connect();

    // Authenticate the user based on password
    const userQuery = 'SELECT * FROM users WHERE password = $1';
    const userResult = await client.query(userQuery, [password]);
    const user = userResult.rows[0];

    if (!user) {
      client.release();
      return res.status(401).json({ message: 'Incorrect password. Access denied.' });
    }

    // Fetch pack details
    const packQuery = 'SELECT * FROM packs WHERE id = $1';
    const packResult = await client.query(packQuery, [id]);
    const pack = packResult.rows[0];

    if (!pack) {
      client.release();
      return res.status(404).json({ message: 'Pack not found' });
    }

    // Validate 'amount' to ensure it's a valid number
    if (isNaN(parseFloat(amount))) {
      client.release();
      return res.status(400).json({ message: 'Invalid amount' });
    }

    // Calculate profit (assuming profit is amount received - pack price)
    const { price } = pack;
    const profit = parseFloat(amount) - parseFloat(price);

    // Insert transaction into database
    const insertTransactionQuery = `
      INSERT INTO transactions (pack_id, amount, profit)
      VALUES ($1, $2, $3)
      RETURNING id, sale_date
    `;
    const transactionResult = await client.query(insertTransactionQuery, [id, parseFloat(amount), profit]);
    const { id: transactionId, sale_date } = transactionResult.rows[0];

    // Update pack status to 'Sold' in the packs table
    const updatePackQuery = 'UPDATE packs SET status = $1 WHERE id = $2';
    await client.query(updatePackQuery, ['Sold', id]);

    client.release();

    res.json({ message: 'Pack marked as sold successfully' });
  } catch (error) {
    console.error('Error marking pack as sold:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Endpoint to fetch transactions
app.get('/transactions', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT id, pack_id, sale_date, amount, profit FROM transactions');
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/transactions/:id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body; // Extract password from request body

  try {
    const client = await pool.connect();

    // Authenticate the user based on password
    const userQuery = 'SELECT * FROM users WHERE password = $1';
    const userResult = await client.query(userQuery, [password]);
    const user = userResult.rows[0];

    if (!user) {
      client.release();
      return res.status(401).json({ message: 'Incorrect password. Access denied.' });
    }

    // Fetch transaction details to find the pack_id
    const transactionQuery = 'SELECT * FROM transactions WHERE id = $1';
    const transactionResult = await client.query(transactionQuery, [id]);
    const transaction = transactionResult.rows[0];

    if (!transaction) {
      client.release();
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const { pack_id } = transaction;

    // Delete transaction from database
    const deleteTransactionQuery = 'DELETE FROM transactions WHERE id = $1';
    await client.query(deleteTransactionQuery, [id]);

    // Check if there are any remaining transactions for the same pack_id
    const remainingTransactionsQuery = 'SELECT * FROM transactions WHERE pack_id = $1';
    const remainingTransactionsResult = await client.query(remainingTransactionsQuery, [pack_id]);
    const remainingTransactions = remainingTransactionsResult.rows;

    // Update pack status based on remaining transactions
    const updatePackQuery = `
      UPDATE packs SET status = $1 WHERE id = $2
    `;

    if (remainingTransactions.length === 0) {
      // No remaining transactions, set pack status to 'Not Sold'
      await client.query(updatePackQuery, ['Not Sold', pack_id]);
    } else {
      // There are remaining transactions, keep pack status as 'Sold'
      await client.query(updatePackQuery, ['Sold', pack_id]);
    }

    client.release();

    res.json({ success: true, message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error('Error deleting transaction:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/packs/count', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT COUNT(*) FROM packs');
    const packCount = parseInt(result.rows[0].count);
    client.release();
    res.json({ count: packCount });
  } catch (error) {
    console.error('Error fetching pack count:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/packs/Sold', async (req, res) => {
  try {
    const client = await pool.connect();

    // Query to get count of sold packs
    const result = await client.query('SELECT COUNT(*) FROM packs WHERE Status = $1', ['Sold']);
    const packSold = parseInt(result.rows[0].count, 10);

    // Query to get total count of all packs
    const totalResult = await client.query('SELECT COUNT(*) FROM packs');
    const totalCount = parseInt(totalResult.rows[0].count, 10);

    client.release();

    // Calculate percentage of sold packs
    let percentageSold = 0;
    if (totalCount > 0) {
      percentageSold = (packSold / totalCount) * 100;
    }

    res.json({ count: packSold, percentage: percentageSold });
  } catch (error) {
    console.error('Error fetching pack count:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Endpoint to calculate and return the sum of profits and percentage of profits
app.get('/transactions/profits', async (req, res) => {
  try {
    const client = await pool.connect();

    // Calculate total profit
    const profitQuery = 'SELECT SUM(profit) AS total_profit FROM transactions';
    const profitResult = await client.query(profitQuery);
    const totalProfit = parseFloat(profitResult.rows[0].total_profit) || 0;

    // Calculate total amount received
    const priceQuery = 'SELECT SUM(price) AS totalprice FROM packs';
    const priceResult = await client.query(priceQuery);
    const totalprice = parseFloat(priceResult.rows[0].totalprice) || 0;

    // Calculate percentage of profits
    let percentageProfit = 0;
    if (totalprice > 0) {
      percentageProfit = (totalProfit / totalprice) * 100;
    }

    client.release();

    res.json({ totalProfit, percentageProfit });
  } catch (error) {
    console.error('Error calculating total profits:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/packs/:id/images', upload.array('images', 10), async (req, res) => {
  const { id } = req.params;
  const images = req.files;

  if (!images || images.length === 0) {
    return res.status(400).json({ message: 'At least one image file is required' });
  }

  try {
    // Check if the pack exists
    const packQuery = 'SELECT * FROM packs WHERE id = $1';
    const packResult = await pool.query(packQuery, [id]);
    const pack = packResult.rows[0];

    if (!pack) {
      return res.status(404).json({ message: 'Pack not found' });
    }

    // Insert each image into the database
    const insertImageQuery = 'INSERT INTO images (pack_id, data) VALUES ($1, $2) RETURNING id';
    const insertPromises = images.map(async (image) => {
      const result = await pool.query(insertImageQuery, [id, image.buffer]);
      return result.rows[0].id;
    });

    const insertedImageIds = await Promise.all(insertPromises);

    res.json({ message: 'Images added to pack successfully', imageIds: insertedImageIds });
  } catch (error) {
    console.error('Error adding images to pack:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.listen(5000, () => {
  console.log('Server is running on port 5000');
});
