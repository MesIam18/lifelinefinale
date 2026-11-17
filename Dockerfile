FROM php:8.3-apache
RUN docker-php-ext-install pdo pdo_mysql
COPY . /var/www/html/
CMD ["/bin/bash", "-c", "sed -i \"s/80/${PORT:-80}/g\" /etc/apache2/sites-available/000-default.conf /etc/apache2/ports.conf && apache2-foreground"]
