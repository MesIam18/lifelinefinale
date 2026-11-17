FROM php:8.3-apache
RUN docker-php-ext-install pdo pdo_mysql && a2enmod rewrite
COPY . /var/www/html/
CMD rm -f /etc/apache2/mods-enabled/mpm_* && ln -s /etc/apache2/mods-available/mpm_prefork.load /etc/apache2/mods-enabled/ && ln -s /etc/apache2/mods-available/mpm_prefork.conf /etc/apache2/mods-enabled/ && sed -i "s/Listen 80/Listen ${PORT:-80}/g; s/:80/:${PORT:-80}/g" /etc/apache2/ports.conf /etc/apache2/sites-available/000-default.conf && apache2-foreground
