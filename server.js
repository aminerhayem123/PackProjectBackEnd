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

  const newNumberOfItems = parseInt(number_of_items, 10);
  const newPrice = parseFloat(price);

  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Fetch current pack details
      const packQuery = 'SELECT status, number_of_items FROM packs WHERE id = $1';
      const packResult = await client.query(packQuery, [id]);
      const pack = packResult.rows[0];

      if (!pack) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Pack not found' });
        return;
      }

      // Check if the pack status is 'Sold' and validate the price
      if (pack.status === 'Sold') {
        const transactionQuery = 'SELECT amount FROM Transactions WHERE pack_id = $1';
        const transactionResult = await client.query(transactionQuery, [id]);
        const transaction = transactionResult.rows[0];

        if (!transaction) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: 'No transaction found for the pack' });
          return;
        }

        const amount = parseFloat(transaction.amount);

        if (newPrice >= amount) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: 'Price must be smaller than the amount in transactions' });
          return;
        }
      }

      // Fetch existing item IDs
      const existingItemsQuery = 'SELECT id FROM items WHERE pack_id = $1';
      const existingItemsResult = await client.query(existingItemsQuery, [id]);
      const existingItemIds = existingItemsResult.rows.map(row => row.id);

      // Determine the number of items to add or remove
      const currentNumberOfItems = pack.number_of_items;
      const difference = newNumberOfItems - currentNumberOfItems;

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
        const itemsToRemove = -difference;
        // Make sure to remove the correct items
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
      const result = await client.query(updatePackQuery, [brand, category, newNumberOfItems, newPrice, id]);
      const updatedPack = result.rows[0];

      await client.query('COMMIT');
      res.status(200).json(updatedPack);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating pack:', error);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error connecting to the database:', err);
    res.status(500).json({ error: 'Internal server error' });
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

// Endpoint to fetch transactions along with pack details
app.get('/transactions', async (req, res) => {
  try {
    const client = await pool.connect();
    
    // Query to fetch transactions and join with packs to get category
    const result = await client.query(`
      SELECT t.id, t.pack_id, t.sale_date, t.amount, t.profit, p.category
      FROM transactions t
      JOIN packs p ON t.pack_id = p.id
    `);
    
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

// Endpoint to get statistics
app.get('/stats', async (req, res) => {
  try {
    const client = await pool.connect();

    // Query 1: Total Number of Items
    const totalItemsResult = await client.query('SELECT COUNT(*) AS total_items FROM items');
    const totalItems = totalItemsResult.rows[0].total_items;

    // Query 2: Number of Items in Each Category
    const itemsByCategoryResult = await client.query(`
      SELECT packs.category, COUNT(items.id) AS number_of_items
      FROM items
      JOIN packs ON items.pack_id = packs.id
      GROUP BY packs.category
      ORDER BY packs.category
    `);

    // Query 3: Number of Packs Sold
    const packsSoldResult = await client.query('SELECT COUNT(*) AS total_packs_sold FROM transactions');
    const totalPacksSold = packsSoldResult.rows[0].total_packs_sold;

    // Query 4: Total Profit and Total Expenses
    const totalsResult = await client.query(`
      SELECT 
        SUM(profit) AS total_profit,
        (SELECT SUM(price) FROM packs) AS total_expenses
      FROM transactions
    `);
    const { total_profit: totalProfit, total_expenses: totalExpenses } = totalsResult.rows[0];

    // Query 5: Percentage of Profit from Expenses
    const profitPercentage = totalExpenses ? (totalProfit / totalExpenses) * 100 : 0;

    // Query 6: Profit and Expenses for Current Month
    const monthlyDataResult = await client.query(`
      SELECT 
        SUM(profit) AS monthly_profit,
        (SELECT SUM(price) FROM packs WHERE created_date >= date_trunc('month', current_date)) AS monthly_expenses
      FROM transactions
      WHERE sale_date >= date_trunc('month', current_date)
    `);
    const { monthly_profit: monthlyProfit, monthly_expenses: monthlyExpenses } = monthlyDataResult.rows[0];
    const monthlyProfitPercentage = monthlyExpenses ? (monthlyProfit / monthlyExpenses) * 100 : 0;

    // Query 7: Profit and Expenses for Current Year
    const yearlyDataResult = await client.query(`
      SELECT 
        SUM(profit) AS yearly_profit,
        (SELECT SUM(price) FROM packs WHERE created_date >= date_trunc('year', current_date)) AS yearly_expenses
      FROM transactions
      WHERE sale_date >= date_trunc('year', current_date)
    `);
    const { yearly_profit: yearlyProfit, yearly_expenses: yearlyExpenses } = yearlyDataResult.rows[0];
    const yearlyProfitPercentage = yearlyExpenses ? (yearlyProfit / yearlyExpenses) * 100 : 0;

    // Query 8: Number of Packs Sold per Category
    const packsSoldByCategoryResult = await client.query(`
      SELECT packs.category, COUNT(transactions.id) AS packs_sold
      FROM transactions
      JOIN packs ON transactions.pack_id = packs.id
      GROUP BY packs.category
      ORDER BY packs.category
    `);

    // Query 9: Profit per Category
    const profitByCategoryResult = await client.query(`
      SELECT packs.category, SUM(transactions.profit) AS category_profit
      FROM transactions
      JOIN packs ON transactions.pack_id = packs.id
      GROUP BY packs.category
      ORDER BY packs.category
    `);

    // Combine data for items by category with packs sold and profit
    const itemsByCategory = itemsByCategoryResult.rows.map(item => {
      const packsSold = packsSoldByCategoryResult.rows.find(pack => pack.category === item.category)?.packs_sold || 0;
      const categoryProfit = profitByCategoryResult.rows.find(profit => profit.category === item.category)?.category_profit || 0;
      return {
        ...item,
        packs_sold: packsSold,
        category_profit: categoryProfit,
      };
    });

    // Response
    res.json({
      totalItems,
      itemsByCategory,
      totalPacksSold,
      totalProfit,
      totalExpenses,
      profitPercentage,
      monthlyProfit,
      monthlyExpenses,
      monthlyProfitPercentage,
      yearlyProfit,
      yearlyExpenses,
      yearlyProfitPercentage,
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Endpoint to delete pack
app.delete('/packs/:id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

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

    // Fetch pack details to ensure it exists
    const packQuery = 'SELECT * FROM packs WHERE id = $1';
    const packResult = await client.query(packQuery, [id]);
    const pack = packResult.rows[0];

    if (!pack) {
      client.release();
      return res.status(404).json({ message: 'Pack not found' });
    }

    // Option 1: Delete related items first
    const deleteItemsQuery = 'DELETE FROM items WHERE pack_id = $1';
    await client.query(deleteItemsQuery, [id]);
    // Option 2: Delete related Transactions first
    const deleteTransactionQuery = 'DELETE FROM Transactions WHERE pack_id = $1';
    await client.query(deleteTransactionQuery, [id]);
    // Option 3: Delete related images first
    const deleteImagesQuery = 'DELETE FROM images WHERE pack_id = $1';
    await client.query(deleteImagesQuery, [id]);
    // Option 3: Update related items to remove the pack reference
    // const updateItemsQuery = 'UPDATE items SET pack_id = NULL WHERE pack_id = $1';
    // await client.query(updateItemsQuery, [id]);

    // Delete the pack
    const deletePackQuery = 'DELETE FROM packs WHERE id = $1';
    await client.query(deletePackQuery, [id]);

    client.release();

    res.json({ success: true, message: 'Pack deleted successfully' });
  } catch (error) {
    console.error('Error deleting pack:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.listen(5000, () => {
  console.log('Server is running on port 5000');
});
