FROM php:8.3-apache
RUN docker-php-ext-install pdo pdo_mysql
RUN a2dismod mpm_event mpm_worker 2>/dev/null || true && a2enmod mpm_prefork rewrite
COPY . /var/www/html/
CMD sed -i "s/Listen 80/Listen ${PORT:-80}/g; s/:80/:${PORT:-80}/g" /etc/apache2/ports.conf /etc/apache2/sites-available/000-default.conf && apache2-foreground
