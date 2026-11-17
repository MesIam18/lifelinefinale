FROM php:8.3-apache
RUN docker-php-ext-install pdo pdo_mysql mbstring
RUN a2enmod rewrite
COPY . /var/www/html/
EXPOSE 8080
CMD ["sh", "-c", "sed -i 's/80/\${PORT:-8080}/g' /etc/apache2/ports.conf /etc/apache2/sites-available/000-default.conf && apache2-foreground"]
