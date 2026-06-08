-- Manual production script (run once).

CREATE TABLE IF NOT EXISTS bookingAgentDeclines (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bookingId INT NOT NULL,
  agentUserId INT NOT NULL,
  reason VARCHAR(500) NULL,
  createdAt DATETIME NOT NULL,
  updatedAt DATETIME NOT NULL,
  UNIQUE KEY booking_agent_declines_booking_agent_unique (bookingId, agentUserId),
  KEY booking_agent_declines_agent_user_id (agentUserId),
  KEY booking_agent_declines_booking_id (bookingId),
  CONSTRAINT fk_bad_booking FOREIGN KEY (bookingId) REFERENCES bookings(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_bad_agent FOREIGN KEY (agentUserId) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);
